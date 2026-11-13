import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"
import { makeFakeDb, type FakeCall, type FakeResult } from "../_fake-db"

const h = vi.hoisted(() => ({
  client: null as any,
  rateAllowed: true,
  store: vi.fn(),
  remove: vi.fn(),
  alert: vi.fn(),
  notify: vi.fn(),
}))

vi.mock("@supabase/supabase-js", () => ({ createClient: () => new Proxy({}, { get: (_t, k) => h.client[k] }) }))
vi.mock("@/lib/support-rate-limit", () => ({ checkSupportRateLimit: vi.fn(async () => ({ allowed: h.rateAllowed })) }))
vi.mock("@/lib/support-attachment", () => ({
  storeThreadAttachment: (...a: any[]) => h.store(...a),
  removeAttachments: (...a: any[]) => h.remove(...a),
}))
vi.mock("@/lib/support-notify", () => ({
  alertAdminsNewThread: (...a: any[]) => h.alert(...a),
  notifyUserSupportEvent: (...a: any[]) => h.notify(...a),
  runAfterResponse: (task: () => Promise<void>) => { void task() },
}))

import { POST } from "./route"

const CALLER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const ORDER = "11111111-1111-4111-8111-111111111111"
const SHOP_ORDER = "22222222-2222-4222-8222-222222222222"
const SHOP = "33333333-3333-4333-8333-333333333333"
/** A time comfortably past every complaint-window wait. */
const OLD = "2026-01-01T00:00:00Z"
const THREAD = "44444444-4444-4444-8444-444444444444"
const MSG = "55555555-5555-4555-8555-555555555555"

const valid = {
  subject: "Data not received",
  category: "order",
  message: "I paid but nothing arrived",
  phone_number: "0241234567",
  whatsapp_number: "0241234567",
}

let handlers: (c: FakeCall) => FakeResult | undefined
let fake: ReturnType<typeof makeFakeDb>

function install(extra: (c: FakeCall) => FakeResult | undefined = () => undefined) {
  handlers = (c) => {
    const o = extra(c)
    if (o) return o
    if (c.table === "support_threads" && c.op === "insert") return { data: { id: THREAD } }
    if (c.table === "support_messages" && c.op === "insert") return { data: { id: MSG } }
    return undefined
  }
  fake = makeFakeDb((c) => handlers(c))
  h.client = {
    ...fake.db,
    auth: {
      getUser: async (t: string) =>
        t === "good" ? { data: { user: { id: CALLER } }, error: null } : { data: { user: null }, error: { message: "bad" } },
    },
  }
}

function req(body: unknown, token: string | null = "good", form?: FormData) {
  const headers: Record<string, string> = {}
  if (token) headers.Authorization = `Bearer ${token}`
  if (!form) headers["content-type"] = "application/json"
  return new NextRequest("http://localhost/api/support/threads", {
    method: "POST",
    headers,
    body: form ?? (typeof body === "string" ? body : JSON.stringify(body)),
  })
}

const writes = (table: string, op: string) => fake.calls.filter((c) => c.table === table && c.op === op)

beforeEach(() => {
  vi.clearAllMocks()
  h.rateAllowed = true
  h.store.mockReset()
  h.remove.mockReset().mockResolvedValue(undefined)
  h.alert.mockReset().mockResolvedValue(undefined)
  h.notify.mockReset().mockResolvedValue(undefined)
  install()
})

describe("POST /api/support/threads", () => {
  it("401 without a bearer token", async () => {
    const res = await POST(req(valid, null))
    expect(res.status).toBe(401)
  })

  it("401 with a token that does not resolve to a user", async () => {
    const res = await POST(req(valid, "nope"))
    expect(res.status).toBe(401)
  })

  it("400 for an invalid phone number, with a short message", async () => {
    const res = await POST(req({ ...valid, phone_number: "12345" }))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.success).toBe(false)
    expect(typeof body.error).toBe("string")
    expect(writes("support_threads", "insert")).toHaveLength(0)
  })

  it("400 for an unparsable body", async () => {
    const res = await POST(req("{not json"))
    expect(res.status).toBe(400)
  })

  it("429 when rate limited and nothing is inserted", async () => {
    h.rateAllowed = false
    const res = await POST(req(valid))
    expect(res.status).toBe(429)
    expect((await res.json()).error).toBe("Too many requests. Please try again later.")
    expect(writes("support_threads", "insert")).toHaveLength(0)
  })

  it("validates before rate limiting (invalid body is 400 even when limited)", async () => {
    h.rateAllowed = false
    const res = await POST(req({ ...valid, subject: "x" }))
    expect(res.status).toBe(400)
  })

  it("404 for an order owned by another user, filtered by caller, no insert, no echo", async () => {
    install((c) => (c.table === "orders" ? { data: null } : undefined))
    const res = await POST(req({ ...valid, order_id: ORDER }))
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error).toBe("Order not found")
    expect(JSON.stringify(body)).not.toContain(ORDER)
    const lookup = fake.calls.find((c) => c.table === "orders")!
    expect(lookup.filters).toContainEqual(["id", ORDER])
    expect(lookup.filters).toContainEqual(["user_id", CALLER])
    expect(writes("support_threads", "insert")).toHaveLength(0)
  })

  it("404 for a shop order whose shop belongs to another user", async () => {
    install((c) => {
      if (c.table === "shop_orders") return { data: { shop_id: SHOP } }
      if (c.table === "user_shops") return { data: null }
      return undefined
    })
    const res = await POST(req({ ...valid, shop_order_id: SHOP_ORDER }))
    expect(res.status).toBe(404)
    const shop = fake.calls.find((c) => c.table === "user_shops")!
    expect(shop.filters).toContainEqual(["user_id", CALLER])
    expect(writes("support_threads", "insert")).toHaveLength(0)
  })

  it("404 for a shop order that does not exist", async () => {
    install((c) => (c.table === "shop_orders" ? { data: null } : undefined))
    const res = await POST(req({ ...valid, shop_order_id: SHOP_ORDER }))
    expect(res.status).toBe(404)
  })

  it("201 for a shop order owned through the caller's shop", async () => {
    install((c) => {
      if (c.table === "shop_orders") return { data: { shop_id: SHOP, order_status: "completed", created_at: OLD, updated_at: OLD } }
      if (c.table === "user_shops") return { data: { id: SHOP } }
      return undefined
    })
    const res = await POST(req({ ...valid, shop_order_id: SHOP_ORDER }))
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ success: true, data: { thread_id: THREAD, attachment_saved: null } })
    const t = writes("support_threads", "insert")[0].payload
    expect(t).toMatchObject({ user_id: CALLER, shop_order_id: SHOP_ORDER, order_id: null })
  })

  it("201 for an owned order; first message inserted as the user", async () => {
    install((c) => (c.table === "orders" ? { data: { id: ORDER, status: "completed", created_at: OLD, updated_at: OLD } } : undefined))
    const res = await POST(req({ ...valid, order_id: ORDER }))
    expect(res.status).toBe(201)
    expect(writes("support_messages", "insert")[0].payload).toMatchObject({
      thread_id: THREAD, sender_role: "user", sender_id: CALLER, body: valid.message,
    })
  })

  it("422 with the reason when the caller's own order is outside the complaint window; nothing inserted", async () => {
    const mins = (m: number) => new Date(Date.now() - m * 60_000).toISOString()
    const cases: [Record<string, unknown>, string][] = [
      [{ status: "completed", created_at: OLD, updated_at: mins(5) }, "You can report this order 15 minutes after it is marked completed."],
      [{ status: "processing", created_at: mins(60), updated_at: mins(60) }, "You can report this order once it has been processing for 3 hours."],
      [{ status: "pending", created_at: OLD, updated_at: OLD }, "Only completed orders, or orders processing for 3 hours, can be reported."],
      [{ status: "failed", created_at: OLD, updated_at: OLD }, "Only completed orders, or orders processing for 3 hours, can be reported."],
    ]
    for (const [row, reason] of cases) {
      install((c) => (c.table === "orders" ? { data: { id: ORDER, ...row } } : undefined))
      const res = await POST(req({ ...valid, order_id: ORDER }))
      expect(res.status).toBe(422)
      expect(await res.json()).toEqual({ success: false, error: reason })
      expect(writes("support_threads", "insert")).toHaveLength(0)
    }
  })

  it("201 for an order processing for more than 3 hours, and a shop order too young is refused", async () => {
    const hours = (n: number) => new Date(Date.now() - n * 3_600_000).toISOString()
    install((c) => (c.table === "orders" ? { data: { id: ORDER, status: "processing", created_at: hours(4), updated_at: hours(0) } } : undefined))
    expect((await POST(req({ ...valid, order_id: ORDER }))).status).toBe(201)
    install((c) => {
      if (c.table === "shop_orders") return { data: { shop_id: SHOP, order_status: "processing", created_at: hours(1), updated_at: hours(1) } }
      if (c.table === "user_shops") return { data: { id: SHOP } }
      return undefined
    })
    const res = await POST(req({ ...valid, shop_order_id: SHOP_ORDER }))
    expect(res.status).toBe(422)
    expect(writes("support_threads", "insert")).toHaveLength(0)
  })

  it("another user's order is still 404, never 422, even when it would be outside the window", async () => {
    install((c) => (c.table === "orders" ? { data: null } : undefined))
    const res = await POST(req({ ...valid, order_id: ORDER }))
    expect(res.status).toBe(404)
  })

  it("409 when the trigger raises OPEN_THREAD_LIMIT", async () => {
    install((c) =>
      c.table === "support_threads" && c.op === "insert" ? { error: { message: "OPEN_THREAD_LIMIT" } } : undefined,
    )
    const res = await POST(req(valid))
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe("You already have 3 open complaints")
    expect(writes("support_messages", "insert")).toHaveLength(0)
  })

  it("500 and deletes the thread when the first message insert fails", async () => {
    install((c) =>
      c.table === "support_messages" && c.op === "insert" ? { error: { message: "boom secret-detail" } } : undefined,
    )
    const res = await POST(req(valid))
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain("secret-detail")
    const del = writes("support_threads", "delete")
    expect(del).toHaveLength(1)
    expect(del[0].filters).toContainEqual(["id", THREAD])
    expect(h.store).not.toHaveBeenCalled()
  })

  it("logs ids only when the compensating thread delete also fails", async () => {
    install((c) => {
      if (c.table === "support_messages" && c.op === "insert") return { error: { message: "boom secret-detail" } }
      if (c.table === "support_threads" && c.op === "delete") return { error: { message: "delete failed secret-detail" } }
      return undefined
    })
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    const res = await POST(req(valid))
    expect(res.status).toBe(500)
    const logged = spy.mock.calls.find((a) => String(a[0]).includes("compensating"))
    expect(logged).toBeDefined()
    expect(logged![1]).toEqual({ userId: CALLER, threadId: THREAD })
    expect(JSON.stringify(spy.mock.calls)).not.toContain("secret-detail")
    spy.mockRestore()
  })

  it("500 on an unexpected throw, generic message", async () => {
    install((c) => {
      if (c.table === "support_threads" && c.op === "insert") throw new Error("kaboom")
      return undefined
    })
    const res = await POST(req(valid))
    expect(res.status).toBe(500)
    expect((await res.json()).error).not.toContain("kaboom")
  })

  function formWith(image?: File, extra: Record<string, string> = {}) {
    const f = new FormData()
    for (const [k, v] of Object.entries({ ...valid, ...extra })) f.set(k, v)
    if (image) f.set("image", image)
    return f
  }

  it("multipart: empty-string order ids are treated as absent", async () => {
    const res = await POST(req(null, "good", formWith(undefined, { order_id: "", shop_order_id: "" })))
    expect(res.status).toBe(201)
    expect(fake.calls.find((c) => c.table === "orders")).toBeUndefined()
  })

  it("image that fails sniffing: 201 with attachment_saved false, thread stays", async () => {
    h.store.mockResolvedValue({ error: "not_image" })
    const file = new File([new Uint8Array([1, 2, 3])], "x.png", { type: "image/png" })
    const res = await POST(req(null, "good", formWith(file)))
    expect(res.status).toBe(201)
    expect((await res.json()).data).toEqual({ thread_id: THREAD, attachment_saved: false })
    expect(writes("support_threads", "delete")).toHaveLength(0)
    expect(writes("support_messages", "update")).toHaveLength(0)
  })

  it("valid image: attachment_saved true and message updated with a threads/<caller>/<thread>/ path", async () => {
    const path = `threads/${CALLER}/${THREAD}/abc.png`
    h.store.mockResolvedValue({ path })
    const file = new File([new Uint8Array([0x89, 0x50])], "x.png", { type: "image/png" })
    const res = await POST(req(null, "good", formWith(file)))
    expect(res.status).toBe(201)
    expect((await res.json()).data).toEqual({ thread_id: THREAD, attachment_saved: true })
    expect(h.store.mock.calls[0][1]).toMatchObject({ userId: CALLER, threadId: THREAD })
    const upd = writes("support_messages", "update")[0]
    expect(upd.payload.attachment_path).toMatch(new RegExp(`^threads/${CALLER}/${THREAD}/`))
    expect(upd.filters).toContainEqual(["id", MSG])
  })

  it("attachment_saved false when the path update fails", async () => {
    h.store.mockResolvedValue({ path: `threads/${CALLER}/${THREAD}/abc.png` })
    install((c) =>
      c.table === "support_messages" && c.op === "update" ? { error: { message: "x" } } : undefined,
    )
    const file = new File([new Uint8Array([0x89, 0x50])], "x.png", { type: "image/png" })
    const res = await POST(req(null, "good", formWith(file)))
    expect(res.status).toBe(201)
    expect((await res.json()).data.attachment_saved).toBe(false)
  })

  it("removes the uploaded file when the attachment path update fails, so no orphan stays", async () => {
    const path = `threads/${CALLER}/${THREAD}/abc.png`
    h.store.mockResolvedValue({ path })
    install((c) =>
      c.table === "support_messages" && c.op === "update" ? { error: { message: "x" } } : undefined,
    )
    const file = new File([new Uint8Array([0x89, 0x50])], "x.png", { type: "image/png" })
    await POST(req(null, "good", formWith(file)))
    expect(h.remove).toHaveBeenCalledTimes(1)
    expect(h.remove.mock.calls[0][1]).toEqual([path])
  })

  it("does not remove the file when the path update succeeds", async () => {
    h.store.mockResolvedValue({ path: `threads/${CALLER}/${THREAD}/abc.png` })
    const file = new File([new Uint8Array([0x89, 0x50])], "x.png", { type: "image/png" })
    await POST(req(null, "good", formWith(file)))
    expect(h.remove).not.toHaveBeenCalled()
  })

  it("an empty file field is ignored (attachment_saved null)", async () => {
    const res = await POST(req(null, "good", formWith(new File([], "e.png", { type: "image/png" }))))
    expect(res.status).toBe(201)
    expect((await res.json()).data.attachment_saved).toBeNull()
    expect(h.store).not.toHaveBeenCalled()
  })

  it("notifies admins and the user after creation", async () => {
    const res = await POST(req(valid))
    expect(res.status).toBe(201)
    await Promise.resolve()
    expect(h.alert).toHaveBeenCalledWith({ threadId: THREAD, subject: valid.subject, summary: valid.message })
    expect(h.notify).toHaveBeenCalledWith(expect.anything(), CALLER, "received", THREAD)
  })

  it("a throwing notification still yields 201", async () => {
    h.alert.mockRejectedValue(new Error("alert down"))
    h.notify.mockRejectedValue(new Error("push down"))
    const res = await POST(req(valid))
    expect(res.status).toBe(201)
    expect(h.notify).toHaveBeenCalled()
  })
})
