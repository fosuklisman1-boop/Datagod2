import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { NextRequest, NextResponse } from "next/server"
import { makeFakeTtb } from "@/lib/text-to-buy/fake-db.test-helper"

const h = vi.hoisted(() => ({ client: null as unknown }))
vi.mock("@/lib/supabase", () => ({
  get supabaseAdmin() {
    return h.client
  },
}))
const authMock = vi.fn()
vi.mock("@/lib/admin-auth", () => ({ verifyAdminAccess: (...a: unknown[]) => authMock(...a) }))
const notifyMock = vi.fn()
vi.mock("@/lib/admin-actions/text-to-buy", () => ({ notifyTextToBuyAdmins: (...a: unknown[]) => notifyMock(...a) }))

import { GET, PUT, POST } from "./route"

const URL_ = "http://localhost/api/admin/text-to-buy"
const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const SENDER = "0200000101"
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`

const req = (method: string, body?: unknown) =>
  new NextRequest(URL_, {
    method,
    headers: { authorization: "Bearer tok", "content-type": "application/json" },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  })

let fake: ReturnType<typeof makeFakeTtb>
const setting = (key: string, value: unknown) => ({ key, value: { value } })
const settingsRows = () => fake.db.tables.admin_settings
const world = (admin: Record<string, unknown>[] = [], messages: Record<string, unknown>[] = []) => {
  fake = makeFakeTtb({ admin_settings: admin, ttb_messages: messages })
  fake.db.rpcImpl = () => ({
    data: [
      { line: "main", texts: 12, prompts: 5, paid: 3, delivered: 2, replies: 20, ai_reads: 4, rule_reads: 8 },
      { line: "shop", texts: 0, prompts: 0, paid: 0, delivered: 0, replies: 0, ai_reads: 0, rule_reads: 0 },
    ],
    error: null,
  })
  h.client = fake.client
}

let spies: ReturnType<typeof vi.spyOn>[]
beforeEach(() => {
  vi.clearAllMocks()
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-placeholder"
  authMock.mockResolvedValue({ isAdmin: true, userId: ADMIN })
  notifyMock.mockResolvedValue(undefined)
  world()
  spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}))
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const consoleText = () => JSON.stringify(spies.flatMap((s) => s.mock.calls))

describe("auth", () => {
  it("passes the auth error response through (401)", async () => {
    authMock.mockResolvedValue({ errorResponse: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) })
    for (const r of [await GET(req("GET")), await PUT(req("PUT", {})), await POST(req("POST", { action: "block" }))]) expect(r.status).toBe(401)
  })
  it("403 for a non-admin on every method, and nothing is written", async () => {
    authMock.mockResolvedValue({ isAdmin: false, userId: "u1" })
    expect((await GET(req("GET"))).status).toBe(403)
    expect((await PUT(req("PUT", { staleMinutes: 15 }))).status).toBe(403)
    expect((await POST(req("POST", { action: "block", sender: SENDER }))).status).toBe(403)
    expect(settingsRows()).toEqual([])
    expect(fake.db.tables.ttb_blocked).toEqual([])
  })
  it("the cron bearer (admin, no user id) may read the overview but is refused on PUT and POST", async () => {
    authMock.mockResolvedValue({ isAdmin: true })
    expect((await GET(req("GET"))).status).toBe(200)
    const put = await PUT(req("PUT", { staleMinutes: 15 }))
    expect(put.status).toBe(403)
    expect((await put.json()).error).toBe("admin_user_required")
    expect((await POST(req("POST", { action: "block", sender: SENDER }))).status).toBe(403)
    expect(settingsRows()).toEqual([])
    expect(fake.db.tables.ttb_blocked).toEqual([])
  })
  it("503 when the service role is not configured", async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY
    expect((await GET(req("GET"))).status).toBe(503)
  })
})

describe("GET overview", () => {
  it("returns settings (no source), both lines, today since 00:00 UTC, last heard, the sms rate and the ai/rule split", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date("2026-11-13T15:30:00Z"))
    world(
      [setting("ttb_main_enabled", true), setting("ttb_main_number", "0200000100")],
    )
    fake.db.tables.ttb_heartbeat.push({ line: "main", last_seen_at: "2026-11-13T15:00:00.000Z" })
    const res = await GET(req("GET"))
    expect(res.status).toBe(200)
    expect(res.headers.get("cache-control")).toBe("no-store")
    const body = await res.json()
    expect(fake.db.rpcCalls).toEqual([{ name: "ttb_overview", args: { p_from: "2026-11-13T00:00:00.000Z" } }])
    expect(body.settingsDefaulted).toBe(false)
    expect(body.settings).toMatchObject({ mainEnabled: true, mainNumber: "0200000100", staleMinutes: 10 })
    expect(body.settings).not.toHaveProperty("source")
    expect(body.smsRateGhs).toBe(0.0243)
    expect(body.overview.main).toEqual({
      enabled: true, number: "0200000100", lastHeardAt: "2026-11-13T15:00:00.000Z",
      today: { texts: 12, prompts: 5, paid: 3, delivered: 2, replies: 20, aiReads: 4, ruleReads: 8 }, smsCostGhs: 0.486,
    })
    expect(body.overview.shop).toMatchObject({ enabled: false, lastHeardAt: null, today: { texts: 0, aiReads: 0, ruleReads: 0 } })
  })
  it("a failed settings read is flagged as defaulted, not hidden", async () => {
    fake.db.failOn.admin_settings = { message: "x" }
    const body = await (await GET(req("GET"))).json()
    expect(body.settingsDefaulted).toBe(true)
    expect(body.settings.mainEnabled).toBe(false)
  })
  it("a database failure is a 500 with a code-only log", async () => {
    fake.db.rpcImpl = () => ({ data: null, error: { message: "secret 0200000101" } })
    const res = await GET(req("GET"))
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain("secret")
    expect(consoleText()).not.toContain("0200000101")
    expect(consoleText()).toContain("[TTB-ADMIN] get failed code=-")
  })
})

describe("PUT settings", () => {
  it("rejects a non-object or unparseable body", async () => {
    for (const b of ["not json", "[]", "5", "null"]) expect((await PUT(req("PUT", b))).status).toBe(400)
  })
  it("rejects unknown keys and source", async () => {
    expect((await (await PUT(req("PUT", { source: "db" }))).json()).error).toBe("unknown_field")
    expect((await PUT(req("PUT", { ttb_main_enabled: true }))).status).toBe(400)
  })
  it("one invalid field among valid ones writes nothing and alerts nobody", async () => {
    const res = await PUT(req("PUT", { staleMinutes: 15, promptsPerHour: 99, aiEnabled: false }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("invalid_promptsPerHour")
    expect(settingsRows()).toEqual([])
    expect(notifyMock).not.toHaveBeenCalled()
  })
  it("a non-boolean confirm is rejected", async () => {
    expect((await PUT(req("PUT", { confirm: "yes", staleMinutes: 15 }))).status).toBe(400)
    expect(settingsRows()).toEqual([])
  })
  it("writes only the CHANGED keys as { value }, with the admin id, and sends one alert naming keys only", async () => {
    world([setting("ttb_stale_minutes", 10), setting("ttb_prompts_per_hour", 3), setting("ttb_main_number", "")])
    const res = await PUT(req("PUT", { staleMinutes: 15, promptsPerHour: 3, mainNumber: "+233200000100", replySenderId: "" }))
    expect(res.status).toBe(200)
    const byKey = Object.fromEntries(settingsRows().map((r) => [r.key as string, r]))
    expect(byKey.ttb_stale_minutes).toMatchObject({ value: { value: 15 }, updated_by: ADMIN })
    expect(byKey.ttb_main_number).toMatchObject({ value: { value: "0200000100" }, updated_by: ADMIN })
    expect(byKey.ttb_prompts_per_hour).toMatchObject({ value: { value: 3 } })
    expect(byKey.ttb_prompts_per_hour).not.toHaveProperty("updated_by")
    expect(byKey).not.toHaveProperty("ttb_reply_sender_id")
    expect(notifyMock).toHaveBeenCalledTimes(1)
    const alert = notifyMock.mock.calls[0][0]
    expect(alert).toEqual({ kind: "setting_changed", keys: ["ttb_main_number", "ttb_stale_minutes"] })
    expect(JSON.stringify(alert)).not.toContain("0200000100")
    const body = await res.json()
    expect(body.settings).toMatchObject({ staleMinutes: 15, mainNumber: "0200000100", promptsPerHour: 3 })
    expect(body.settings).not.toHaveProperty("source")
    expect(res.headers.get("cache-control")).toBe("no-store")
  })
  it("unchanged values write nothing and send no alert", async () => {
    world([setting("ttb_stale_minutes", 15), setting("ttb_ai_enabled", true)])
    const before = JSON.stringify(settingsRows())
    const res = await PUT(req("PUT", { staleMinutes: 15, aiEnabled: true, retentionDays: 30 })) // 30 is the default
    expect(res.status).toBe(200)
    expect(JSON.stringify(settingsRows())).toBe(before)
    expect(notifyMock).not.toHaveBeenCalled()
    expect((await res.json()).settings.staleMinutes).toBe(15)
  })
  it("an empty patch is a no-op", async () => {
    expect((await PUT(req("PUT", {}))).status).toBe(200)
    expect(settingsRows()).toEqual([])
    expect(notifyMock).not.toHaveBeenCalled()
  })
  it("turning the feature on needs confirm: true", async () => {
    world([setting("ttb_main_enabled", false)])
    const refused = await PUT(req("PUT", { mainEnabled: true }))
    expect(refused.status).toBe(400)
    expect((await refused.json()).error).toBe("confirm_required")
    expect((await PUT(req("PUT", { mainEnabled: true, confirm: false }))).status).toBe(400)
    expect(settingsRows()).toEqual([setting("ttb_main_enabled", false)])
    expect(notifyMock).not.toHaveBeenCalled()

    const ok = await PUT(req("PUT", { mainEnabled: true, confirm: true }))
    expect(ok.status).toBe(200)
    expect(settingsRows()[0]).toMatchObject({ key: "ttb_main_enabled", value: { value: true } })
    expect((await ok.json()).settings.mainEnabled).toBe(true)
    expect(notifyMock).toHaveBeenCalledWith({ kind: "setting_changed", keys: ["ttb_main_enabled"] })
  })
  it("the confirm check also covers the very first save (no row yet, default false)", async () => {
    expect((await PUT(req("PUT", { mainEnabled: true }))).status).toBe(400)
  })
  it("turning it off, or re-sending on while already on, needs no confirm", async () => {
    world([setting("ttb_main_enabled", true)])
    expect((await PUT(req("PUT", { mainEnabled: true }))).status).toBe(200)
    expect((await PUT(req("PUT", { mainEnabled: false }))).status).toBe(200)
    expect(settingsRows()[0]).toMatchObject({ value: { value: false } })
  })
  it("refuses to write while the saved settings cannot be read", async () => {
    fake.db.failOn.admin_settings = { message: "down" }
    const res = await PUT(req("PUT", { staleMinutes: 15 }))
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe("settings_unavailable")
    expect(notifyMock).not.toHaveBeenCalled()
  })
  it("a save failure is a 500, no alert, and the log has a code only", async () => {
    world([setting("ttb_stale_minutes", 10)])
    // Reads work, the upsert fails: fail only on the second admin_settings call.
    let calls = 0
    const from = (fake.client as unknown as { from: (t: string) => unknown }).from.bind(fake.client)
    ;(fake.client as unknown as { from: (t: string) => unknown }).from = (t: string) => {
      if (t === "admin_settings" && ++calls === 2) fake.db.failOn.admin_settings = { message: "leak 0200000101" }
      return from(t)
    }
    const res = await PUT(req("PUT", { staleMinutes: 15 }))
    expect(res.status).toBe(500)
    expect(notifyMock).not.toHaveBeenCalled()
    expect(consoleText()).not.toContain("0200000101")
    expect(consoleText()).toContain("[TTB-ADMIN] settings failed code=-")
  })
  it("never logs setting values", async () => {
    world([setting("ttb_main_number", "")])
    await PUT(req("PUT", { mainNumber: "0200000100", replySenderId: "Datagod" }))
    expect(consoleText()).not.toContain("0200000100")
    expect(consoleText()).not.toContain("Datagod")
  })
})

describe("POST actions", () => {
  it("rejects a bad body and an unknown action", async () => {
    expect((await POST(req("POST", "nope"))).status).toBe(400)
    expect((await (await POST(req("POST", { action: "wipe" }))).json()).error).toBe("invalid_action")
    expect((await POST(req("POST", {}))).status).toBe(400)
  })
  it("block then unblock", async () => {
    const blocked = await POST(req("POST", { action: "block", sender: "+233200000101", reason: "  spam run  " }))
    expect(blocked.status).toBe(200)
    expect(fake.db.tables.ttb_blocked).toEqual([{ sender: SENDER, reason: "spam run", blocked_by: ADMIN }])
    expect(blocked.headers.get("cache-control")).toBe("no-store")

    const again = await POST(req("POST", { action: "block", sender: SENDER }))
    expect(again.status).toBe(200)
    expect(fake.db.tables.ttb_blocked).toEqual([{ sender: SENDER, reason: null, blocked_by: ADMIN }])

    const un = await POST(req("POST", { action: "unblock", sender: SENDER }))
    expect(await un.json()).toEqual({ ok: true, removed: true })
    expect(fake.db.tables.ttb_blocked).toEqual([])
    expect(await (await POST(req("POST", { action: "unblock", sender: SENDER }))).json()).toEqual({ ok: true, removed: false })
  })
  it("validates sender and reason", async () => {
    expect((await (await POST(req("POST", { action: "block", sender: "12345" }))).json()).error).toBe("invalid_sender")
    expect((await POST(req("POST", { action: "block" }))).status).toBe(400)
    expect((await POST(req("POST", { action: "unblock", sender: 5 }))).status).toBe(400)
    expect((await (await POST(req("POST", { action: "block", sender: SENDER, reason: "x".repeat(201) }))).json()).error).toBe("invalid_reason")
    expect((await POST(req("POST", { action: "block", sender: SENDER, reason: 5 }))).status).toBe(400)
    expect((await POST(req("POST", { action: "block", sender: SENDER, reason: "x".repeat(200) }))).status).toBe(200)
    expect(fake.db.tables.ttb_blocked).toHaveLength(1)
  })
  it("misread flags an inbound row only; an outbound or unknown id is 404", async () => {
    world([], [
      { id: id(1), line: "main", sender: SENDER, direction: "in", body: "b", created_at: "2026-11-13T10:00:00Z", misread: false },
      { id: id(2), line: "main", sender: SENDER, direction: "out", body: "r", created_at: "2026-11-13T10:00:01Z", misread: false },
    ])
    expect((await POST(req("POST", { action: "misread", messageId: id(1) }))).status).toBe(200)
    expect(fake.db.tables.ttb_messages[0].misread).toBe(true)
    expect((await POST(req("POST", { action: "misread", messageId: id(2) }))).status).toBe(404)
    expect(fake.db.tables.ttb_messages[1].misread).toBe(false)
    expect((await POST(req("POST", { action: "misread", messageId: id(9) }))).status).toBe(404)
    expect((await POST(req("POST", { action: "misread", messageId: "nope" }))).status).toBe(400)
    expect((await POST(req("POST", { action: "misread" }))).status).toBe(400)
  })
  it("a database failure is a 500 with a code-only log", async () => {
    fake.db.failOn.ttb_blocked = { message: "row 0200000101" }
    const res = await POST(req("POST", { action: "block", sender: SENDER, reason: "private reason" }))
    expect(res.status).toBe(500)
    expect(consoleText()).not.toContain("0200000101")
    expect(consoleText()).not.toContain("private reason")
    expect(consoleText()).toContain("[TTB-ADMIN] action failed code=-")
  })
})
