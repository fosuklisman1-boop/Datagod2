import { describe, it, expect, vi } from "vitest"
import { setAdminCap, parseThresholds, saveMoneySettings, getMoneySettingsAdmin, getDeveloperSpend, THRESHOLD_KEYS } from "./money"

const U = "11111111-1111-4111-8111-111111111111"
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"

function client(o: { rpc?: Record<string, unknown>; rows?: Record<string, unknown>; error?: unknown } = {}) {
  const rpc = vi.fn(async (fn: string, _args?: Record<string, unknown>) => ({ data: o.rpc?.[fn] ?? null, error: null }))
  const from = vi.fn((table: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {
      select: () => chain, eq: () => chain, gte: () => chain, order: () => chain, limit: () => chain,
      maybeSingle: async () => ({ data: o.rows?.[table] ?? null, error: o.error ?? null }),
      then: (res: (v: unknown) => void) => res({ data: o.rows?.[table] ?? [], error: o.error ?? null }),
    }
    return chain
  })
  return { c: { rpc, from } as never, rpc, from }
}

describe("setAdminCap", () => {
  it("no actor (CRON path) -> 403 before any rpc; bad user id or bad cap -> 400 before any rpc", async () => {
    const { c, rpc } = client()
    expect((await setAdminCap(c, { userId: U, cap: 20, actorId: undefined })).status).toBe(403)
    expect((await setAdminCap(c, { userId: "nope", cap: 20, actorId: A })).status).toBe(400)
    expect((await setAdminCap(c, { userId: U, cap: 0, actorId: A })).status).toBe(400)
    expect((await setAdminCap(c, { userId: U, cap: "12.345", actorId: A })).status).toBe(400)
    expect(rpc).not.toHaveBeenCalled()
  })
  it("calls the user-scope rpc with the verified admin as actor; null removes the limit; not_found -> 404", async () => {
    const ok = client({ rpc: { api_v2_set_spend_cap: { ok: true, changed: true } } })
    expect((await setAdminCap(ok.c, { userId: U, cap: "50", actorId: A })).status).toBe(200)
    expect(ok.rpc).toHaveBeenCalledWith("api_v2_set_spend_cap", { p_scope: "user", p_scope_id: U, p_cap: 50, p_actor: A })
    await setAdminCap(ok.c, { userId: U, cap: null, actorId: A })
    expect(ok.rpc.mock.calls[1][1]).toMatchObject({ p_cap: null })
    const nf = client({ rpc: { api_v2_set_spend_cap: { ok: false, code: "not_found" } } })
    expect((await setAdminCap(nf.c, { userId: U, cap: 5, actorId: A })).status).toBe(404)
  })
})

describe("parseThresholds", () => {
  it("knows exactly the 11 SQL keys", () => {
    expect([...THRESHOLD_KEYS].sort()).toEqual([
      "cap_hits", "cap_hits_minutes", "failure_min_orders", "failure_minutes", "failure_ratio", "fanout_minutes",
      "fanout_recipients", "new_key_hours", "new_key_min_ghs", "spike_min_ghs", "spike_multiplier",
    ])
  })
  it("drops unknown keys; keeps valid numbers", () => {
    expect(parseThresholds({ spike_multiplier: 4, failure_ratio: 0.6, evil: 1 })).toEqual({ ok: true, value: { spike_multiplier: 4, failure_ratio: 0.6 } })
    expect(parseThresholds(undefined)).toEqual({ ok: true, value: null })
  })
  it("refuses non-numbers, zero, negatives, infinities and out-of-range values", () => {
    for (const bad of [
      { spike_multiplier: "3" }, { spike_min_ghs: 0 }, { cap_hits: -1 }, { fanout_minutes: Infinity }, { failure_ratio: 1.5 },
      { fanout_minutes: 1441 }, { new_key_hours: 169 }, { spike_min_ghs: 1000001 }, { cap_hits: 2.5 }, { spike_multiplier: null },
    ]) expect(parseThresholds(bad).ok).toBe(false)
    expect(parseThresholds([1]).ok).toBe(false)
    expect(parseThresholds("x").ok).toBe(false)
  })
})

describe("saveMoneySettings", () => {
  it("no actor -> 403; non-boolean switch or bad thresholds -> 400; all before any rpc", async () => {
    const { c, rpc } = client()
    expect((await saveMoneySettings(c, { capsEnabled: true, alertsEnabled: null, thresholds: undefined, actorId: undefined })).status).toBe(403)
    expect((await saveMoneySettings(c, { capsEnabled: "yes", alertsEnabled: null, thresholds: undefined, actorId: A })).status).toBe(400)
    expect((await saveMoneySettings(c, { capsEnabled: null, alertsEnabled: null, thresholds: { cap_hits: 0 }, actorId: A })).status).toBe(400)
    expect(rpc).not.toHaveBeenCalled()
  })
  it("passes the admin as actor, null switches mean unchanged, and invalidates the snapshot only on a change", async () => {
    const changed = client({ rpc: { api_v2_set_money_settings: { ok: true, changed: true } } })
    const invalidate = vi.fn()
    const r = await saveMoneySettings(changed.c, { capsEnabled: true, alertsEnabled: null, thresholds: { cap_hits: 5 }, actorId: A }, { invalidate })
    expect(r.status).toBe(200)
    expect(changed.rpc).toHaveBeenCalledWith("api_v2_set_money_settings", { p_caps: true, p_alerts: null, p_thresholds: { cap_hits: 5 }, p_actor: A })
    expect(invalidate).toHaveBeenCalledTimes(1)
    const same = client({ rpc: { api_v2_set_money_settings: { ok: true, changed: false } } })
    const inv2 = vi.fn()
    await saveMoneySettings(same.c, { capsEnabled: false, alertsEnabled: false, thresholds: undefined, actorId: A }, { invalidate: inv2 })
    expect(inv2).not.toHaveBeenCalled()
  })
})

describe("getMoneySettingsAdmin", () => {
  it("returns both switches, the thresholds (numbers only) and today's alert count", async () => {
    const { c } = client({
      rows: {
        api_v2_money_settings: { caps_enabled: true, alerts_enabled: false, thresholds: { cap_hits: 3, failure_ratio: 0.5, junk: "x" }, updated_at: "2026-11-25T10:00:00Z" },
        api_v2_risk_alerts: [{ id: "1" }, { id: "2" }],
      },
    })
    const r = await getMoneySettingsAdmin(c, new Date("2026-11-25T12:00:00Z"))
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ capsEnabled: true, alertsEnabled: false, thresholds: { cap_hits: 3, failure_ratio: 0.5 }, alertsToday: 2 })
    expect(JSON.stringify(r.body)).not.toContain("junk")
  })
  it("a missing settings row reads as both switches off", async () => {
    const { c } = client({ rows: {} })
    const r = await getMoneySettingsAdmin(c, new Date())
    expect(r.body).toMatchObject({ capsEnabled: false, alertsEnabled: false })
  })
})

describe("getDeveloperSpend", () => {
  const today = { user: { spent: 12, cap: 50 }, keys: [{ key_id: "k1", spent: 7.5, cap: 30 }, { key_id: "k2", spent: 4.5, cap: null }], refusals_today: 2 }
  it("bad id -> 400; shapes today's spend against each cap, refusals today and recent alerts (signal + time, numbers only, no phones)", async () => {
    expect((await getDeveloperSpend(client().c, "nope")).status).toBe(400)
    const { c } = client({
      rpc: { api_v2_spend_today: today },
      rows: { api_v2_risk_alerts: [{ signal: "recipient_fanout", created_at: "2026-11-25T09:00:00Z", details: { recipients: 41, phone: "0241234567", key: "dg2_live_x" } }] },
    })
    const r = await getDeveloperSpend(c, U)
    expect(r.status).toBe(200)
    expect(r.body).toEqual({
      today: 12, userCap: 50,
      keys: [{ keyId: "k1", spent: 7.5, cap: 30 }, { keyId: "k2", spent: 4.5, cap: null }],
      refusalsToday: 2,
      alerts: [{ signal: "recipient_fanout", createdAt: "2026-11-25T09:00:00Z", details: { recipients: 41 } }],
    })
    expect(JSON.stringify(r.body)).not.toContain("0241234567")
  })
})
