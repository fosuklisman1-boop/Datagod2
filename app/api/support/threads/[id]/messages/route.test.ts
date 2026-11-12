import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"
import { makeFakeDb, type FakeCall, type FakeResult } from "../../../_fake-db"

const h = vi.hoisted(() => ({ client: null as any, rateAllowed: true }))

vi.mock("@supabase/supabase-js", () => ({ createClient: () => new Proxy({}, { get: (_t, k) => h.client[k] }) }))
vi.mock("@/lib/support-rate-limit", () => ({ checkSupportRateLimit: vi.fn(async () => ({ allowed: h.rateAllowed })) }))

import { POST } from "./route"
import { checkSupportRateLimit } from "@/lib/support-rate-limit"

const CALLER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const THREAD = "44444444-4444-4444-8444-444444444444"
const MSG = "55555555-5555-4555-8555-555555555555"

let fake: ReturnType<typeof makeFakeDb>

function install(thread: any, extra: (c: FakeCall) => FakeResult | undefined = () => undefined) {
  fake = makeFakeDb((c) => {
    const o = extra(c)
    if (o) return o
    if (c.table === "support_threads" && c.op === "select") {
      // Honour the ownership filter like the real database would.
      const owner = c.filters.find(([k]) => k === "user_id")?.[1]
      return { data: thread && owner === thread.user_id ? thread : null }
    }
    if (c.table === "support_messages" && c.op === "insert") return { data: { id: MSG, created_at: "2026-11-12T10:00:00Z" } }
    return undefined
  })
  h.client = {
    ...fake.db,
    auth: {
      getUser: async (t: string) =>
        t === "good" ? { data: { user: { id: CALLER } }, error: null } : { data: { user: null }, error: { message: "bad" } },
    },
  }
}

function call(id: string, body: unknown, token: string | null = "good") {
  const headers: Record<string, string> = { "content-type": "application/json" }
  if (token) headers.Authorization = `Bearer ${token}`
  const request = new NextRequest(`http://localhost/api/support/threads/${id}/messages`, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
  return POST(request, { params: Promise.resolve({ id }) })
}

beforeEach(() => {
  vi.clearAllMocks()
  h.rateAllowed = true
  install({ id: THREAD, user_id: CALLER, status: "open" })
})

describe("POST /api/support/threads/[id]/messages", () => {
  it("401 without a token", async () => {
    expect((await call(THREAD, { message: "hi" }, null)).status).toBe(401)
  })

  it("400 for a non-uuid id", async () => {
    const res = await call("not-a-uuid", { message: "hello" })
    expect(res.status).toBe(400)
    expect(fake.calls).toHaveLength(0)
  })

  it("400 for an empty message and for an unparsable body", async () => {
    expect((await call(THREAD, { message: "   " })).status).toBe(400)
    expect((await call(THREAD, "{oops")).status).toBe(400)
  })

  it("404 for another user's thread, identical to a missing one", async () => {
    install({ id: THREAD, user_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", status: "open" })
    const other = await call(THREAD, { message: "hello" })
    install(null)
    const missing = await call(THREAD, { message: "hello" })
    expect(other.status).toBe(404)
    expect(missing.status).toBe(404)
    expect(await other.json()).toEqual(await missing.json())
    expect(fake.calls.filter((c) => c.op === "insert")).toHaveLength(0)
  })

  it("filters the thread lookup by id and caller", async () => {
    await call(THREAD, { message: "hello" })
    const lookup = fake.calls.find((c) => c.table === "support_threads")!
    expect(lookup.filters).toContainEqual(["id", THREAD])
    expect(lookup.filters).toContainEqual(["user_id", CALLER])
  })

  it("409 for a closed thread", async () => {
    install({ id: THREAD, user_id: CALLER, status: "closed" })
    const res = await call(THREAD, { message: "hello" })
    expect(res.status).toBe(409)
    expect(fake.calls.filter((c) => c.op === "insert")).toHaveLength(0)
  })

  it("429 when over the per-minute limit (11th message)", async () => {
    h.rateAllowed = false
    const res = await call(THREAD, { message: "hello" })
    expect(res.status).toBe(429)
    expect(checkSupportRateLimit).toHaveBeenCalledWith(expect.anything(), "message_send", CALLER)
    expect(fake.calls.filter((c) => c.op === "insert")).toHaveLength(0)
  })

  it("201 inserts a user message as the caller", async () => {
    const res = await call(THREAD, { message: "Any update?" })
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ success: true, data: { id: MSG, created_at: "2026-11-12T10:00:00Z" } })
    const ins = fake.calls.find((c) => c.table === "support_messages" && c.op === "insert")!
    expect(ins.payload).toMatchObject({ thread_id: THREAD, sender_role: "user", sender_id: CALLER, body: "Any update?" })
  })

  it("500 with a generic message when the insert fails", async () => {
    install({ id: THREAD, user_id: CALLER, status: "open" }, (c) =>
      c.table === "support_messages" && c.op === "insert" ? { error: { message: "db-detail" } } : undefined,
    )
    const res = await call(THREAD, { message: "hello" })
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain("db-detail")
  })
})
