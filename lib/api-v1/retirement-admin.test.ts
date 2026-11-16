import { describe, expect, it } from "vitest"
import {
  buildExemptMessage,
  buildNoticeMessage,
  findMissingUserIds,
  loadStragglers,
  parseRetirementUpdate,
  sendNotices,
} from "./retirement-admin"

const NOW = new Date("2026-11-12T10:00:00Z")
const U1 = "11111111-1111-4111-8111-111111111111"
const U2 = "22222222-2222-4222-8222-222222222222"
const SUNSET = new Date("2026-12-01T00:00:00Z")

describe("parseRetirementUpdate", () => {
  it("accepts null sunset and empty list", () => {
    expect(parseRetirementUpdate({ sunset_at: null, exempt_user_ids: [] }, NOW)).toEqual({
      ok: true,
      value: { sunset_at: null, exempt_user_ids: [] },
    })
  })
  it("normalises an ISO date and dedupes ids", () => {
    const r = parseRetirementUpdate({ sunset_at: "2026-12-01T00:00:00Z", exempt_user_ids: [U1, U1] }, NOW)
    expect(r).toEqual({ ok: true, value: { sunset_at: "2026-12-01T00:00:00.000Z", exempt_user_ids: [U1] } })
  })
  it("rejects an invalid date", () => {
    expect(parseRetirementUpdate({ sunset_at: "not-a-date", exempt_user_ids: [] }, NOW).ok).toBe(false)
  })
  it("rejects a missing sunset_at and non-object bodies", () => {
    expect(parseRetirementUpdate({ exempt_user_ids: [] }, NOW).ok).toBe(false)
    expect(parseRetirementUpdate(null, NOW).ok).toBe(false)
  })
  it("rejects a non-UUID id", () => {
    expect(parseRetirementUpdate({ sunset_at: null, exempt_user_ids: ["abc"] }, NOW).ok).toBe(false)
  })
  it("rejects 51 ids but allows 50", () => {
    const mk = (n: number) =>
      Array.from({ length: n }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`)
    expect(parseRetirementUpdate({ sunset_at: null, exempt_user_ids: mk(51) }, NOW).ok).toBe(false)
    expect(parseRetirementUpdate({ sunset_at: null, exempt_user_ids: mk(50) }, NOW).ok).toBe(true)
  })
})

describe("message builders", () => {
  it("builds the exact notice text", () => {
    expect(buildNoticeMessage(SUNSET)).toBe(
      "Datagod API notice: API v1 will be retired on 1 Dec 2026, 00:00 GMT. After that, v1 requests will be refused. Please move to API v2: https://www.datagod.store/developers"
    )
  })
  it("builds the exact exempt text", () => {
    expect(buildExemptMessage(SUNSET)).toBe(
      "Datagod API notice: API v1 retires for most users on 1 Dec 2026, 00:00 GMT. Your v1 access will keep working for now while you move to API v2: https://www.datagod.store/developers. We'll contact you before it ends."
    )
  })
})

function fakeClient(tables: Record<string, any[]>) {
  const calls: { table: string; ops: string[] }[] = []
  return {
    calls,
    from(table: string) {
      const ops: string[] = []
      calls.push({ table, ops })
      let rows = tables[table] ?? []
      const q: any = {
        select: (c: string) => (ops.push(`select:${c}`), q),
        gte: () => (ops.push("gte"), q),
        is: () => (ops.push("is"), q),
        order: () => q,
        limit: (n: number) => (ops.push(`limit:${n}`), q),
        in: (_c: string, v: string[]) => ((rows = rows.filter((r) => v.includes(r.id))), ops.push("in"), q),
        then: (res: any) => res({ data: rows, error: null }),
      }
      return q
    },
  }
}

describe("findMissingUserIds", () => {
  it("returns ids not in users", async () => {
    const c = fakeClient({ users: [{ id: U1 }] })
    expect(await findMissingUserIds(c, [U1, U2])).toEqual([U2])
  })
})

describe("loadStragglers", () => {
  it("groups calls and orders per user, flags exempt, bounded and no key_hash", async () => {
    const c = fakeClient({
      user_api_logs: [
        { user_id: U1, created_at: "2026-11-11T00:00:00Z" },
        { user_id: U1, created_at: "2026-11-12T00:00:00Z" },
        { user_id: U2, created_at: "2026-11-10T00:00:00Z" },
      ],
      api_orders: [{ user_id: U1, created_at: "2026-11-11T00:00:00Z" }],
      users: [{ id: U1, email: "a@x.com" }, { id: U2, email: null }],
    })
    const out = await loadStragglers(c, [U2], NOW)
    expect(out[0]).toEqual({ user_id: U1, email: "a@x.com", last_call: "2026-11-12T00:00:00Z", calls_7d: 2, orders_7d: 1, exempt: false })
    expect(out[1]).toMatchObject({ user_id: U2, calls_7d: 1, orders_7d: 0, exempt: true })
    const all = c.calls.flatMap((x) => x.ops).join(" ")
    expect(all).toContain("limit:")
    expect(all).not.toContain("key_hash")
  })
})

describe("sendNotices", () => {
  it("sends the right text per exemption, both channels, continuing past failures", async () => {
    const sent: { kind: string; to: string; msg: string }[] = []
    const recipients = [
      { user_id: U1, email: "a@x.com", phone: "0240000001", first_name: "A" },
      { user_id: U2, email: "b@x.com", phone: "0240000002", first_name: "B" },
      { user_id: "u3", email: null, phone: "0240000003", first_name: null },
    ]
    const r = await sendNotices(recipients, [U2], SUNSET, {
      sms: async ({ phone, message }) => {
        if (phone === "0240000001") throw new Error("boom")
        sent.push({ kind: "sms", to: phone, msg: message })
        return { success: true }
      },
      email: async ({ email, text }) => {
        sent.push({ kind: "email", to: email, msg: text })
        return { success: email !== "b@x.com" }
      },
    })
    expect(r).toEqual({ sms_sent: 2, email_sent: 1, failed: 2 })
    expect(sent.find((s) => s.to === "0240000002")!.msg).toBe(buildExemptMessage(SUNSET))
    expect(sent.find((s) => s.to === "0240000003")!.msg).toBe(buildNoticeMessage(SUNSET))
    expect(sent.find((s) => s.to === "a@x.com")!.msg).toBe(buildNoticeMessage(SUNSET))
  })
})
