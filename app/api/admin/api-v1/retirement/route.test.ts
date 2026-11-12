import { NextRequest, NextResponse } from "next/server"
import { beforeEach, describe, expect, it, vi } from "vitest"

const verifyMock = vi.fn()
vi.mock("@/lib/admin-auth", () => ({ verifyAdminAccess: (...a: unknown[]) => verifyMock(...a) }))

const h = vi.hoisted(() => ({
  cfg: null as any,
  users: [] as any[],
  keys: [] as any[],
  updates: [] as any[],
  sms: [] as { phone: string; message: string; type: string }[],
  emails: [] as { to: { email: string }[]; textContent?: string }[],
  failPhone: "",
  events: [] as string[],
  afterRead: null as null | (() => void),
  failAll: false,
}))

vi.mock("@/lib/api-v2/store", () => ({
  getAdminClient: () => ({
    from(table: string) {
      let rows: any[] = []
      let mode = "select"
      let patch: any = null
      const conds: [string, any][] = []
      let applied = false
      const apply = () => {
        if (mode !== "update" || applied) return
        applied = true
        const ok = conds.every(([c, v]) => (h.cfg[c] ?? null) === v)
        if (!ok) return (rows = [])
        h.updates.push(patch)
        h.events.push("claim-or-update")
        h.cfg = { ...h.cfg, ...patch }
        rows = [h.cfg]
      }
      const q: any = {
        select: () => {
          if (table === "api_v2_config" && mode !== "update") rows = [{ ...h.cfg }]
          if (table === "users") rows = h.users
          if (table === "user_api_keys") rows = h.keys
          if (table === "user_api_logs" || table === "api_orders") rows = []
          return q
        },
        update: (p: any) => ((mode = "update"), (patch = p), q),
        in: (_c: string, v: string[]) => ((rows = rows.filter((r) => v.includes(r.id))), q),
        eq: (c: string, v: any) => (c !== "id" && conds.push([c, v]), q),
        is: (c: string, v: any) => (table === "api_v2_config" && conds.push([c, v]), q),
        gte: () => q,
        order: () => q,
        limit: () => q,
        maybeSingle: async () => {
          apply()
          const r = { data: rows[0] ?? null, error: null }
          if (table === "api_v2_config" && mode === "select" && h.afterRead) h.afterRead()
          return r
        },
        then: (res: any) => (apply(), res({ data: mode === "update" ? null : rows, error: null })),
      }
      return q
    },
  }),
}))
vi.mock("@/lib/sms-service", () => ({
  sendSMS: async (p: any) => {
    h.events.push("send")
    if (h.failAll || p.phone === h.failPhone) throw new Error("boom")
    h.sms.push(p)
    return { success: true }
  },
}))
vi.mock("@/lib/email-service", () => ({
  sendEmail: async (p: any) => (h.events.push("send"), h.emails.push(p), { success: !h.failAll }),
}))

import { GET, PUT } from "./route"
import { POST } from "./notify/route"
import { buildExemptMessage, buildNoticeMessage } from "@/lib/api-v1/retirement-admin"

const U1 = "11111111-1111-4111-8111-111111111111"
const U2 = "22222222-2222-4222-8222-222222222222"
const U3 = "33333333-3333-4333-8333-333333333333"
const req = (method: string, body?: unknown) =>
  new NextRequest("http://x/api/admin/api-v1/retirement", { method, body: body === undefined ? undefined : JSON.stringify(body) })

beforeEach(() => {
  verifyMock.mockResolvedValue({ isAdmin: true, userId: "admin-1" })
  h.cfg = { v1_sunset_at: "2026-12-01T00:00:00Z", v1_exempt_user_ids: [U2], v1_notice_sent_at: null }
  h.users = [
    { id: U1, email: "a@x.com", phone_number: "0240000001", first_name: "A" },
    { id: U2, email: "b@x.com", phone_number: "0240000002", first_name: "B" },
    { id: U3, email: null, phone_number: "0240000003", first_name: "C" },
  ]
  h.keys = [{ user_id: U1 }, { user_id: U2 }, { user_id: U3 }, { user_id: U1 }]
  h.updates = []
  h.sms = []
  h.emails = []
  h.failPhone = ""
  h.events = []
  h.afterRead = null
  h.failAll = false
})

const deny = () => verifyMock.mockResolvedValue({ isAdmin: false, errorResponse: NextResponse.json({ error: "Forbidden" }, { status: 403 }) })

describe("admin api-v1 retirement routes", () => {
  it("non-admin gets 403 on GET, PUT and notify", async () => {
    deny()
    expect((await GET(req("GET"))).status).toBe(403)
    expect((await PUT(req("PUT", { sunset_at: null, exempt_user_ids: [] }))).status).toBe(403)
    expect((await POST(req("POST", {}))).status).toBe(403)
    expect(h.sms).toHaveLength(0)
  })

  it("a rate-limited admin (isAdmin true + 429) is honoured", async () => {
    verifyMock.mockResolvedValue({ isAdmin: true, errorResponse: NextResponse.json({}, { status: 429 }) })
    expect((await GET(req("GET"))).status).toBe(429)
  })

  it("PUT with an invalid body is 400 and writes nothing", async () => {
    expect((await PUT(req("PUT", { sunset_at: "garbage", exempt_user_ids: [] }))).status).toBe(400)
    expect((await PUT(req("PUT", { sunset_at: null, exempt_user_ids: ["nope"] }))).status).toBe(400)
    expect(h.updates).toHaveLength(0)
  })

  it("PUT rejects exempt ids that are not users", async () => {
    const res = await PUT(req("PUT", { sunset_at: null, exempt_user_ids: ["44444444-4444-4444-8444-444444444444"] }))
    expect(res.status).toBe(400)
    expect(h.updates).toHaveLength(0)
  })

  it("PUT saves valid settings", async () => {
    const res = await PUT(req("PUT", { sunset_at: "2026-12-05T00:00:00Z", exempt_user_ids: [U1] }))
    expect(res.status).toBe(200)
    expect(h.updates[0]).toMatchObject({ v1_sunset_at: "2026-12-05T00:00:00.000Z", v1_exempt_user_ids: [U1] })
  })

  it("GET returns settings and exempt users", async () => {
    const body = await (await GET(req("GET"))).json()
    expect(body.sunset_at).toBe("2026-12-01T00:00:00Z")
    expect(body.exempt_users).toEqual([{ id: U2, email: "b@x.com", phone: "0240000002", first_name: "B" }])
    expect(body.stragglers).toEqual([])
  })

  it("notify returns 409 already_sent without confirm_resend and sends nothing", async () => {
    h.cfg.v1_notice_sent_at = "2026-11-10T00:00:00Z"
    const res = await POST(req("POST", {}))
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: "already_sent", sent_at: "2026-11-10T00:00:00Z" })
    expect(h.sms).toHaveLength(0)
  })

  it("notify sends the right text to exempt vs non-exempt and survives a failing recipient", async () => {
    h.cfg.v1_notice_sent_at = "2026-11-10T00:00:00Z"
    h.failPhone = "0240000001"
    const res = await POST(req("POST", { confirm_resend: true }))
    expect(res.status).toBe(200)
    const sunset = new Date("2026-12-01T00:00:00Z")
    expect(h.sms.find((s) => s.phone === "0240000002")!.message).toBe(buildExemptMessage(sunset))
    expect(h.sms.find((s) => s.phone === "0240000003")!.message).toBe(buildNoticeMessage(sunset))
    expect(h.sms.every((s) => s.type === "api_v1_retirement_notice")).toBe(true)
    expect(h.emails.map((e) => e.to[0].email).sort()).toEqual(["a@x.com", "b@x.com"])
    expect(await res.json()).toEqual({ sms_sent: 2, email_sent: 2, failed: 1 })
    expect(h.updates.at(-1).v1_notice_sent_at).toBeTruthy()
  })

  it("claims the notice before any message is sent", async () => {
    await POST(req("POST", {}))
    expect(h.events[0]).toBe("claim-or-update")
    expect(h.events.indexOf("send")).toBeGreaterThan(0)
    expect(h.cfg.v1_notice_sent_at).toBeTruthy()
  })

  it("a lost claim race (first send) is 409 with zero sends", async () => {
    h.afterRead = () => { h.cfg.v1_notice_sent_at = "2026-11-12T09:00:00Z" }
    const res = await POST(req("POST", {}))
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe("already_sent")
    expect(h.events.filter((e) => e === "send")).toHaveLength(0)
  })

  it("confirm_resend with a stale previous stamp is 409 with zero sends", async () => {
    h.cfg.v1_notice_sent_at = "2026-11-10T00:00:00Z"
    h.afterRead = () => { h.cfg.v1_notice_sent_at = "2026-11-12T09:00:00Z" }
    const res = await POST(req("POST", { confirm_resend: true }))
    expect(res.status).toBe(409)
    expect(h.events.filter((e) => e === "send")).toHaveLength(0)
  })

  it("restores the previous stamp when every send fails", async () => {
    h.cfg.v1_notice_sent_at = "2026-11-10T00:00:00Z"
    h.failAll = true
    const res = await POST(req("POST", { confirm_resend: true }))
    expect(await res.json()).toMatchObject({ sms_sent: 0, email_sent: 0 })
    expect(h.cfg.v1_notice_sent_at).toBe("2026-11-10T00:00:00Z")
  })

  it("restores null when the first-ever notice sends nothing", async () => {
    h.failAll = true
    await POST(req("POST", {}))
    expect(h.cfg.v1_notice_sent_at).toBeNull()
  })
})
