import { describe, it, expect, vi } from "vitest"
import { planNotify, runNotify, type NotifyRow, type NotifyAttempt, type NotifyDeps } from "./notify"
import { DEFAULT_BLOCKED_SETTINGS, type BlockedNumbersSettings } from "./settings"

const NOW = new Date("2026-11-15T10:00:00.000Z")
const DAY = 86_400_000
const SETTINGS: BlockedNumbersSettings = { ...DEFAULT_BLOCKED_SETTINGS, enabled: true, customer_sms_enabled: true, daily_sms_ceiling: 300 }
const iso = (msAgo: number) => new Date(NOW.getTime() - msAgo).toISOString()

const row = (id: string, over: Partial<NotifyRow> = {}): NotifyRow => ({
  id,
  phone: `024${id.padStart(7, "0")}`,
  ready_sms_count: 0,
  ready_sms_window_start: null,
  notify_attempts: 0,
  last_shop_id: null,
  ...over,
})
const att = (over: Partial<NotifyAttempt>): NotifyAttempt => ({
  surface: "storefront",
  shop_id: null,
  user_id: null,
  purchaser_phone: null,
  created_at: iso(DAY),
  ...over,
})
const ctx = {
  shops: new Map([
    ["shopA", { name: "Alpha Shop", subdomain: "alpha" }],
    ["shopB", { name: "Bravo Shop", subdomain: "bravo" }],
  ]),
  rootDomain: "datagod.store",
  mainUssdCode: "*713*235#",
}
const plan = (
  rows: NotifyRow[],
  attempts: Record<string, NotifyAttempt[]>,
  over: { settings?: Partial<BlockedNumbersSettings>; sentToday?: number; phones?: Map<string, number> } = {}
) =>
  planNotify(
    rows,
    new Map(Object.entries(attempts)),
    NOW,
    { ...SETTINGS, ...over.settings },
    over.sentToday ?? 0,
    over.phones ?? new Map(),
    ctx
  )

describe("planNotify", () => {
  it("customer_sms_enabled:false: no sms, reason sms_off, shop and dealer notices still planned", () => {
    const p = plan(
      [row("1"), row("2")],
      {
        "1": [att({ surface: "storefront", shop_id: "shopA" })],
        "2": [att({ surface: "dashboard", user_id: "u1" })],
      },
      { settings: { customer_sms_enabled: false } }
    )
    expect(p.sms).toEqual([])
    expect(p.skipped).toContainEqual({ numberId: "1", reason: "sms_off" })
    expect(p.shopNotices).toEqual([{ shopId: "shopA", count: 1, texted: false }])
    expect(p.dealerNotices).toEqual([{ userId: "u1", count: 1 }])
  })

  it("texts the verified purchaser phone of the latest eligible attempt", () => {
    const p = plan([row("1")], {
      "1": [att({ surface: "ussd_uzo_shop", shop_id: "shopA", purchaser_phone: "0551112222" })],
    })
    expect(p.sms).toHaveLength(1)
    expect(p.sms[0].to).toBe("0551112222")
    expect(p.sms[0].numberId).toBe("1")
  })

  it("falls back to the blocked number when there is no purchaser phone", () => {
    const r = row("1")
    const p = plan([r], { "1": [att({ surface: "storefront", shop_id: "shopA" })] })
    expect(p.sms[0].to).toBe(r.phone)
  })

  it("dealer-only attempts: no sms (not_eligible) and one dealer notice", () => {
    const p = plan([row("1")], { "1": [att({ surface: "dashboard_bulk", user_id: "u1" })] })
    expect(p.sms).toEqual([])
    expect(p.skipped).toContainEqual({ numberId: "1", reason: "not_eligible" })
    expect(p.dealerNotices).toEqual([{ userId: "u1", count: 1 }])
  })

  it("attempts at shop A then B: notices for both, texted only for B, sms links B", () => {
    const p = plan([row("1")], {
      "1": [
        att({ surface: "storefront", shop_id: "shopA", created_at: iso(3 * DAY) }),
        att({ surface: "storefront", shop_id: "shopB", created_at: iso(1 * DAY) }),
      ],
    })
    const byShop = Object.fromEntries(p.shopNotices.map((n) => [n.shopId, n]))
    expect(byShop.shopA).toEqual({ shopId: "shopA", count: 1, texted: false })
    expect(byShop.shopB).toEqual({ shopId: "shopB", count: 1, texted: true })
    expect(p.sms[0].text).toContain("bravo.datagod.store")
    expect(p.sms[0].text).not.toContain("alpha.datagod.store")
  })

  it("a dealer attempt does not decide the sms: the shop attempt does", () => {
    const p = plan([row("1")], {
      "1": [
        att({ surface: "storefront", shop_id: "shopA", created_at: iso(3 * DAY) }),
        att({ surface: "dashboard", user_id: "u1", created_at: iso(1 * DAY) }),
      ],
    })
    expect(p.sms).toHaveLength(1)
    expect(p.sms[0].text).toContain("alpha.datagod.store")
    expect(p.dealerNotices).toEqual([{ userId: "u1", count: 1 }])
  })

  it("no shop on the eligible attempt: main USSD copy", () => {
    const p = plan([row("1")], { "1": [att({ surface: "text_to_buy", purchaser_phone: "0551112222" })] })
    expect(p.sms[0].text).toContain("*713*235#")
  })

  it("cap_number: 2 ready sms inside 90 days", () => {
    const p = plan([row("1", { ready_sms_count: 2, ready_sms_window_start: iso(10 * DAY) })], {
      "1": [att({ shop_id: "shopA" })],
    })
    expect(p.sms).toEqual([])
    expect(p.skipped).toContainEqual({ numberId: "1", reason: "cap_number" })
  })

  it("an old window (over 90 days) no longer caps the number", () => {
    const p = plan([row("1", { ready_sms_count: 2, ready_sms_window_start: iso(91 * DAY) })], {
      "1": [att({ shop_id: "shopA" })],
    })
    expect(p.sms).toHaveLength(1)
  })

  it("cap_phone: notify phone already has 2 in 90 days", () => {
    const r = row("1")
    const p = plan([r], { "1": [att({ shop_id: "shopA" })] }, { phones: new Map([[r.phone, 2]]) })
    expect(p.skipped).toContainEqual({ numberId: "1", reason: "cap_phone" })
    expect(p.sms).toEqual([])
  })

  it("cap_phone also counts texts planned earlier in the same run", () => {
    const rows = [row("1"), row("2"), row("3")]
    const same = "0551112222"
    const p = plan(rows, Object.fromEntries(rows.map((r) => [r.id, [att({ surface: "ussd_uzo", purchaser_phone: same })]])))
    expect(p.sms).toHaveLength(2)
    expect(p.skipped).toContainEqual({ numberId: "3", reason: "cap_phone" })
  })

  it("ceiling: sentToday at daily_sms_ceiling blocks sms, and a run cannot overshoot", () => {
    const p = plan([row("1")], { "1": [att({ shop_id: "shopA" })] }, { sentToday: 300 })
    expect(p.skipped).toContainEqual({ numberId: "1", reason: "ceiling" })
    const rows = [row("1"), row("2"), row("3")]
    const p2 = plan(rows, Object.fromEntries(rows.map((r) => [r.id, [att({ shop_id: "shopA" })]])), {
      sentToday: 299,
    })
    expect(p2.sms).toHaveLength(1)
    expect(p2.skipped.filter((s) => s.reason === "ceiling")).toHaveLength(2)
  })

  it("ceiling 0 sends nothing", () => {
    const p = plan([row("1")], { "1": [att({ shop_id: "shopA" })] }, { settings: { daily_sms_ceiling: 0 } })
    expect(p.sms).toEqual([])
  })

  it("three numbers for one dealer: one notice with count 3", () => {
    const rows = [row("1"), row("2"), row("3")]
    const p = plan(rows, Object.fromEntries(rows.map((r) => [r.id, [att({ surface: "api_v2", user_id: "u9" })]])))
    expect(p.dealerNotices).toEqual([{ userId: "u9", count: 3 }])
  })

  it("ignores attempts older than the retention window", () => {
    const p = plan([row("1")], { "1": [att({ shop_id: "shopA", created_at: iso(45 * DAY) })] })
    expect(p.sms).toEqual([])
    expect(p.shopNotices).toEqual([])
  })
})

// ---- runNotify with an in-memory fake db ----
type R = Record<string, unknown>
function fakeDb(tables: Record<string, R[]>) {
  const writes: { table: string; patch: R; id: unknown }[] = []
  function from(table: string) {
    const rows = tables[table] ?? []
    const preds: ((r: R) => boolean)[] = []
    let patch: R | null = null
    let head = false
    let lim = Infinity
    const b: any = {
      select(_c?: string, o?: { head?: boolean }) { head = !!o?.head; return b },
      update(p: R) { patch = p; return b },
      eq(c: string, v: unknown) { preds.push((r) => r[c] === v); return b },
      in(c: string, v: unknown[]) { preds.push((r) => v.includes(r[c])); return b },
      is(c: string, v: unknown) { preds.push((r) => (r[c] ?? null) === v); return b },
      not(c: string, _op: string, v: unknown) { preds.push((r) => (r[c] ?? null) !== v); return b },
      lt(c: string, v: any) { preds.push((r) => (r[c] as any) < v); return b },
      gte(c: string, v: any) { preds.push((r) => r[c] != null && (r[c] as any) >= v); return b },
      order() { return b },
      limit(n: number) { lim = n; return b },
      then(res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) {
        const m = rows.filter((r) => preds.every((p) => p(r)))
        if (patch) {
          for (const r of m) { Object.assign(r, patch); writes.push({ table, patch: patch!, id: r.id }) }
          return Promise.resolve({ data: m.map((r) => ({ id: r.id })), error: null }).then(res, rej)
        }
        if (head) return Promise.resolve({ count: m.length, error: null }).then(res, rej)
        return Promise.resolve({ data: m.slice(0, lim), error: null }).then(res, rej)
      },
    }
    return b
  }
  return { db: { from } as any, writes, tables }
}

const N1 = {
  id: "n1", phone: "0241111111", status: "allowed", customer_notified_at: null, customer_notify_phone: null,
  notify_attempts: 0, ready_sms_count: 0, ready_sms_window_start: null, last_shop_id: "shopA",
}

function setup(over: Partial<NotifyDeps> = {}, t: Record<string, R[]> = {}) {
  const numbers = (t.mtn_blocked_numbers ?? [{ ...N1 }]) as R[]
  const f = fakeDb({
    mtn_blocked_numbers: numbers,
    mtn_blocked_attempts: t.mtn_blocked_attempts ?? [
      { blocked_number_id: "n1", surface: "ussd_uzo_shop", shop_id: "shopA", user_id: null, purchaser_phone: "0551112222", created_at: iso(DAY) },
    ],
    user_shops: t.user_shops ?? [{ id: "shopA", user_id: "owner1", shop_name: "Alpha Shop", subdomain: "alpha" }],
  })
  const deps: NotifyDeps = {
    db: f.db,
    sendSms: vi.fn(async () => ({ success: true })) as any,
    insertNotification: vi.fn(async () => {}),
    sendPush: vi.fn(async () => {}),
    readUssdCodes: vi.fn(async () => ({ main: "*713*235#", shop: null })),
    settings: vi.fn(async () => SETTINGS),
    now: () => NOW,
    rootDomain: "datagod.store",
    ...over,
  }
  return { f, deps, numbers }
}

describe("runNotify", () => {
  it("sends, records the send, and notifies the shop owner", async () => {
    const { f, deps, numbers } = setup()
    const out = await runNotify(deps)
    expect(out).toEqual({ texted: 1, shopNotices: 1, dealerNotices: 0, skipped: 0, failed: 0 })
    expect(deps.sendSms).toHaveBeenCalledTimes(1)
    const call = (deps.sendSms as any).mock.calls[0][0]
    expect(call).toMatchObject({ phone: "0551112222", type: "mtn_number_ready", reference: "n1" })
    expect(numbers[0]).toMatchObject({
      customer_notify_phone: "0551112222",
      customer_notified_at: NOW.toISOString(),
      ready_sms_count: 1,
      ready_sms_window_start: NOW.toISOString(),
    })
    expect(f.writes.every((w) => (w.patch as R).updated_at)).toBe(true)
    expect(deps.insertNotification).toHaveBeenCalledWith(
      "owner1",
      "Customer numbers ready",
      "1 customer number(s) blocked on Alpha Shop are now ready, we've texted them to buy again.",
      "/dashboard/blocked-numbers"
    )
    expect(deps.sendPush).not.toHaveBeenCalled()
  })

  it("keeps the window start when it is inside 90 days and bumps the count", async () => {
    const start = iso(10 * DAY)
    const { numbers, deps } = setup({}, {
      mtn_blocked_numbers: [{ ...N1, ready_sms_count: 1, ready_sms_window_start: start }],
    })
    await runNotify(deps)
    expect(numbers[0]).toMatchObject({ ready_sms_count: 2, ready_sms_window_start: start })
  })

  it("a skip reason sets customer_notified_at but never a notify phone or count", async () => {
    const { deps, numbers } = setup({ settings: vi.fn(async () => ({ ...SETTINGS, customer_sms_enabled: false })) })
    const out = await runNotify(deps)
    expect(deps.sendSms).not.toHaveBeenCalled()
    expect(out.skipped).toBe(1)
    expect(numbers[0].customer_notified_at).toBe(NOW.toISOString())
    expect(numbers[0].customer_notify_phone).toBeNull()
    expect(numbers[0].ready_sms_count).toBe(0)
    expect(out.shopNotices).toBe(1)
    expect((deps.insertNotification as any).mock.calls[0][2]).toBe("1 customer number(s) blocked on Alpha Shop are now ready.")
  })

  it("a failed send bumps notify_attempts, leaves the row un-notified, and defers notices", async () => {
    const { deps, numbers } = setup({ sendSms: vi.fn(async () => ({ success: false, error: "x" })) as any })
    const out = await runNotify(deps)
    expect(out.failed).toBe(1)
    expect(out.texted).toBe(0)
    expect(numbers[0].customer_notified_at).toBeNull()
    expect(numbers[0].customer_notify_phone).toBeNull()
    expect(numbers[0].notify_attempts).toBe(1)
    expect(numbers[0].ready_sms_count).toBe(0)
    expect(deps.insertNotification).not.toHaveBeenCalled()
  })

  it("a sendSMS that throws counts as a failure", async () => {
    const { deps, numbers } = setup({ sendSms: vi.fn(async () => { throw new Error("boom") }) as any })
    const out = await runNotify(deps)
    expect(out.failed).toBe(1)
    expect(numbers[0].notify_attempts).toBe(1)
  })

  it("the third failed send still gives the owner their notice (untexted)", async () => {
    const { deps } = setup({ sendSms: vi.fn(async () => ({ success: false })) as any }, {
      mtn_blocked_numbers: [{ ...N1, notify_attempts: 2 }],
    })
    await runNotify(deps)
    expect((deps.insertNotification as any).mock.calls[0][2]).toBe("1 customer number(s) blocked on Alpha Shop are now ready.")
  })

  it("a skipped sendSMS (SMS disabled) is neither a send nor a failure", async () => {
    const { deps, numbers } = setup({ sendSms: vi.fn(async () => ({ success: true, skipped: true })) as any })
    const out = await runNotify(deps)
    expect(out.texted).toBe(0)
    expect(out.failed).toBe(0)
    expect(out.skipped).toBe(1)
    expect(numbers[0].ready_sms_count).toBe(0)
    expect(numbers[0].customer_notify_phone).toBeNull()
  })

  it("does not select rows that are notified, exhausted, or not allowed", async () => {
    const base = { phone: "0241111111", customer_notify_phone: null, ready_sms_count: 0, ready_sms_window_start: null, last_shop_id: null }
    const { deps } = setup({}, {
      mtn_blocked_numbers: [
        { ...base, id: "a", status: "allowed", customer_notified_at: iso(DAY), notify_attempts: 0 },
        { ...base, id: "b", status: "allowed", customer_notified_at: null, notify_attempts: 3 },
        { ...base, id: "c", status: "blocked", customer_notified_at: null, notify_attempts: 0 },
      ],
    })
    expect(await runNotify(deps)).toEqual({ texted: 0, shopNotices: 0, dealerNotices: 0, skipped: 0, failed: 0 })
    expect(deps.sendSms).not.toHaveBeenCalled()
  })

  it("dealer notice: in-app plus push, never an sms", async () => {
    const { deps } = setup({}, {
      mtn_blocked_attempts: [
        { blocked_number_id: "n1", surface: "api_v1", shop_id: null, user_id: "dealer1", purchaser_phone: null, created_at: iso(DAY) },
      ],
    })
    const out = await runNotify(deps)
    expect(deps.sendSms).not.toHaveBeenCalled()
    expect(out.dealerNotices).toBe(1)
    expect(deps.insertNotification).toHaveBeenCalledWith(
      "dealer1",
      "Blocked numbers ready",
      "1 of your blocked numbers are now ready for data; open Blocked numbers to re-order",
      "/dashboard/blocked-numbers"
    )
    expect(deps.sendPush).toHaveBeenCalledWith("dealer1", expect.objectContaining({ body: expect.stringContaining("now ready") }))
  })

  it("counts today's already-texted rows against the ceiling", async () => {
    const { deps } = setup({ settings: vi.fn(async () => ({ ...SETTINGS, daily_sms_ceiling: 1 })) }, {
      mtn_blocked_numbers: [
        {
          id: "x", phone: "0240000001", status: "allowed", customer_notified_at: NOW.toISOString(),
          customer_notify_phone: "0551112222", notify_attempts: 0, ready_sms_count: 1,
          ready_sms_window_start: iso(DAY), last_shop_id: null,
        },
        { ...N1 },
      ],
    })
    const out = await runNotify(deps)
    expect(deps.sendSms).not.toHaveBeenCalled()
    expect(out.skipped).toBe(1)
  })

  it("never logs phone numbers or sms text", async () => {
    const spies = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")]
    const { deps } = setup({ sendSms: vi.fn(async () => ({ success: false, error: "0551112222 bad" })) as any })
    await runNotify(deps)
    const all = spies.flatMap((s) => s.mock.calls).flat().join(" ")
    expect(all).not.toMatch(/0551112222|0241111111|DTGOD/)
    spies.forEach((s) => s.mockRestore())
  })
})
