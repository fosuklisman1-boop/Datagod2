import { describe, it, expect, vi, beforeEach } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"

vi.mock("@/lib/network-prefix-config", () => ({
  getPrefixValidationConfig: vi.fn(async () => ({ enabled: true, map: undefined })),
}))
vi.mock("@/lib/pricing/wallet-order-price", () => ({
  walletOrderPrice: vi.fn(),
}))

import { prepareWalletOrder } from "./prepare-wallet-order"
import { walletOrderPrice } from "@/lib/pricing/wallet-order-price"

type Row = Record<string, any>

function fakeDb(tables: Record<string, Row[]>) {
  let seq = 0
  return {
    tables,
    from(table: string) {
      const rows = (tables[table] ??= [])
      const filters: Array<(r: Row) => boolean> = []
      let op: "select" | "update" | "insert" = "select"
      let patch: Row = {}
      let inserted: Row | null = null
      const run = () => {
        if (op === "insert") {
          const row = {
            id: `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`,
            status: "pending",
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            ...inserted,
          }
          rows.push(row)
          return { data: [row], error: null }
        }
        const matched = rows.filter((r) => filters.every((f) => f(r)))
        if (op === "update") matched.forEach((r) => Object.assign(r, patch))
        return { data: matched.map((r) => ({ ...r })), error: null }
      }
      const b: any = {
        insert(r: Row) { op = "insert"; inserted = r; return b },
        update(p: Row) { op = "update"; patch = p; return b },
        select() { return b },
        eq(c: string, v: unknown) { filters.push((r) => r[c] === v || (c === "size" && String(r[c]) === String(v))); return b },
        ilike(c: string, v: string) {
          // Postgres ILIKE: unescaped % and _ are wildcards, backslash escapes
          let re = ""
          for (let i = 0; i < v.length; i++) {
            const ch = v[i]
            if (ch === "\\" && i + 1 < v.length) re += v[++i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
            else if (ch === "%") re += ".*"
            else if (ch === "_") re += "."
            else re += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
          }
          const rx = new RegExp(`^${re}$`, "i")
          filters.push((r) => rx.test(String(r[c])))
          return b
        },
        not(c: string, _o: string, v: string) {
          const list = v.replace(/[()]/g, "").split(",")
          filters.push((r) => !list.includes(r[c]))
          return b
        },
        gt(c: string, v: string) { filters.push((r) => r[c] > v); return b },
        order() { return b },
        limit() { return b },
        single() { const x = run(); return Promise.resolve({ data: x.data![0] ?? null, error: x.data!.length ? null : { message: "no row" } }) },
        maybeSingle() { const x = run(); return Promise.resolve({ data: x.data![0] ?? null, error: null }) },
        then(res: any, rej: any) { return Promise.resolve(run()).then(res, rej) },
      }
      return b
    },
  } as unknown as SupabaseClient & { tables: Record<string, Row[]> }
}

const USER = "11111111-1111-4111-8111-111111111111"
const PKG = "33333333-3333-4333-8333-333333333333"
const CTX = { userId: USER, userRole: "user", conversationKey: "conv-1" }

function setup(opts: { balance?: number | null; pkgs?: Row[]; orders?: Row[] } = {}) {
  const pkgs = opts.pkgs ?? [{ id: PKG, network: "MTN", size: "1", price: 5, dealer_price: 4, is_available: true }]
  const wallets = opts.balance === null ? [] : [{ user_id: USER, balance: opts.balance ?? 100 }]
  return fakeDb({ packages: pkgs, wallets, orders: opts.orders ?? [], ai_drafts: [] })
}

const minsAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString()
const input = (over: Record<string, unknown> = {}) => ({ network: "MTN", size: "1", phone_number: "0241110001", ...over })

beforeEach(() => {
  vi.mocked(walletOrderPrice).mockReset()
  vi.mocked(walletOrderPrice).mockResolvedValue(5)
})

describe("prepareWalletOrder", () => {
  it("unknown_package_refused", async () => {
    const r: any = await prepareWalletOrder(setup({ pkgs: [] }), CTX, input({ phone_number: "0241110002" }))
    expect(r.refused).toBe(true)
    expect(r.code).toBe("unknown_package")
  })

  it("insufficient_balance_refused", async () => {
    const db = setup({ balance: 2 })
    const r: any = await prepareWalletOrder(db, CTX, input({ phone_number: "0241110003" }))
    expect(r.code).toBe("insufficient_balance")
    expect(db.tables.ai_drafts).toHaveLength(0)
  })

  it("missing wallet refused as insufficient_balance", async () => {
    const r: any = await prepareWalletOrder(setup({ balance: null }), CTX, input({ phone_number: "0241110004" }))
    expect(r.code).toBe("insufficient_balance")
  })

  it("over_cap_refused", async () => {
    vi.mocked(walletOrderPrice).mockResolvedValue(500.5)
    const r: any = await prepareWalletOrder(setup({ balance: 9999 }), CTX, input({ phone_number: "0241110005" }))
    expect(r.code).toBe("over_cap")
  })

  it("prefix_mismatch_refused", async () => {
    // 020 is a Telecel prefix; the order is MTN
    const r: any = await prepareWalletOrder(setup(), CTX, input({ phone_number: "0201110006" }))
    expect(r.code).toBe("prefix_mismatch")
  })

  it("invalid_phone_refused", async () => {
    const r: any = await prepareWalletOrder(setup(), CTX, input({ phone_number: "12345" }))
    expect(r.code).toBe("invalid_phone")
  })

  it("prices_unavailable when price read throws", async () => {
    vi.mocked(walletOrderPrice).mockRejectedValue(new Error("custom price read failed"))
    const r: any = await prepareWalletOrder(setup(), CTX, input({ phone_number: "0241110007" }))
    expect(r.code).toBe("prices_unavailable")
  })

  it("hourly_schedule_refused", async () => {
    const r: any = await prepareWalletOrder(setup(), CTX, input({ phone_number: "0241110008", schedule: { type: "hourly" } }))
    expect(r.code).toBe("hourly_not_allowed")
  })

  it("creates a draft with masked recipient and normalised phone", async () => {
    const db = setup()
    const r: any = await prepareWalletOrder(db, CTX, input({ phone_number: "+233241114567" }))
    expect(r.refused).toBeUndefined()
    expect(r.draft_id).toBeTruthy()
    expect(r.warnings).toEqual([])
    expect(r.display.recipientMasked).toBe("024 *** 4567")
    expect(r.display.title).toBe("Confirm data order")
    expect(r.display.balanceBefore).toBe(100)
    expect(r.display.balanceAfter).toBe(95)
    const row = db.tables.ai_drafts[0]
    expect(row.action).toBe("wallet_order")
    expect(row.context).toBe("dashboard")
    expect(row.amount_ghs).toBe(5)
    expect(row.params.recipient).toBe("0241114567")
  })

  it("duplicate_recent_warns", async () => {
    const orders = [{ user_id: USER, package_id: PKG, phone_number: "0241110009", status: "completed", created_at: minsAgo(3) }]
    const db = setup({ orders })
    const r: any = await prepareWalletOrder(db, CTX, input({ phone_number: "0241110009" }))
    expect(r.draft_id).toBeTruthy()
    expect(r.warnings).toContain("duplicate_recent")
    expect(JSON.stringify(r.display.lines)).toMatch(/ordered this for/)
  })

  it("old_order_no_warning", async () => {
    const orders = [{ user_id: USER, package_id: PKG, phone_number: "0241110010", status: "completed", created_at: minsAgo(11) }]
    const r: any = await prepareWalletOrder(setup({ orders }), CTX, input({ phone_number: "0241110010" }))
    expect(r.warnings).toEqual([])
  })

  it("failed recent order does not warn", async () => {
    const orders = [{ user_id: USER, package_id: PKG, phone_number: "0241110011", status: "failed", created_at: minsAgo(2) }]
    const r: any = await prepareWalletOrder(setup({ orders }), CTX, input({ phone_number: "0241110011" }))
    expect(r.warnings).toEqual([])
  })

  it("price_from_walletOrderPrice (a dealer gets the dealer price)", async () => {
    vi.mocked(walletOrderPrice).mockResolvedValue(4)
    const r: any = await prepareWalletOrder(setup(), { ...CTX, userRole: "dealer" }, input({ phone_number: "0241110012" }))
    expect(r.display.priceGhs).toBe(4)
    expect(vi.mocked(walletOrderPrice).mock.calls[0][2]).toBe("dealer")
  })

  const sched = (phone: string, schedule: unknown) => prepareWalletOrder(setup(), CTX, input({ phone_number: phone, schedule })) as Promise<any>
  const future = () => new Date(Date.now() + 86_400_000).toISOString()

  it("weekly_without_days_refused", async () => {
    expect((await sched("0241120001", { type: "weekly", runAtTime: "08:00" })).code).toBe("invalid_schedule")
    expect((await sched("0241120002", { type: "weekly", runAtTime: "08:00", runOnDays: [] })).code).toBe("invalid_schedule")
  })

  it("run_on_days_out_of_range_refused", async () => {
    expect((await sched("0241120003", { type: "weekly", runAtTime: "08:00", runOnDays: [1, 7] })).code).toBe("invalid_schedule")
    expect((await sched("0241120004", { type: "weekly", runAtTime: "08:00", runOnDays: [1.5] })).code).toBe("invalid_schedule")
    expect((await sched("0241120005", { type: "weekly", runAtTime: "08:00", runOnDays: [1, 1] })).code).toBe("invalid_schedule")
  })

  it("bad_run_at_time_refused", async () => {
    expect((await sched("0241120006", { type: "daily", runAtTime: "25:00" })).code).toBe("invalid_schedule")
    expect((await sched("0241120007", { type: "daily", runAtTime: "8:00" })).code).toBe("invalid_schedule")
    expect((await sched("0241120008", { type: "daily" })).code).toBe("invalid_schedule")
  })

  it("once_in_past_refused", async () => {
    expect((await sched("0241120009", { type: "once", runAtTimestamp: new Date(Date.now() - 60_000).toISOString() })).code).toBe("invalid_schedule")
    expect((await sched("0241120010", { type: "once", runAtTimestamp: "not a date" })).code).toBe("invalid_schedule")
    expect((await sched("0241120011", { type: "once" })).code).toBe("invalid_schedule")
  })

  it("unknown schedule type is invalid_schedule, hourly stays hourly_not_allowed", async () => {
    expect((await sched("0241120012", { type: "monthly", runAtTime: "08:00" })).code).toBe("invalid_schedule")
    expect((await sched("0241120013", { type: "hourly" })).code).toBe("hourly_not_allowed")
  })

  it("schedule_extra_keys_dropped", async () => {
    const db = setup()
    const ts = future()
    const r: any = await prepareWalletOrder(db, CTX, input({
      phone_number: "0241120014",
      schedule: { type: "once", runAtTimestamp: ts, runAtTime: "09:00", runOnDays: [3], evil: "x" },
    }))
    expect(r.draft_id).toBeTruthy()
    expect(db.tables.ai_drafts[0].params.schedule).toEqual({ type: "once", runAtTimestamp: ts })
    const w: any = await prepareWalletOrder(db, CTX, input({
      phone_number: "0241120015",
      schedule: { type: "weekly", runAtTime: "08:00", runOnDays: [5, 1], extra: 1 },
    }))
    expect(w.draft_id).toBeTruthy()
    expect(db.tables.ai_drafts[1].params.schedule).toEqual({ type: "weekly", runAtTime: "08:00", runOnDays: [1, 5] })
  })

  it("params_use_resolved_package_values", async () => {
    const db = setup({ pkgs: [{ id: PKG, network: "MTN", size: 1, price: 5, dealer_price: 4, is_available: true }] })
    const r: any = await prepareWalletOrder(db, CTX, input({ network: "mtn", size: "1", phone_number: "0241120016" }))
    expect(r.draft_id).toBeTruthy()
    expect(db.tables.ai_drafts[0].params.network).toBe("MTN")
    expect(db.tables.ai_drafts[0].params.size).toBe("1")
    expect(JSON.stringify(r.display.lines)).toContain("MTN 1")
  })

  it("network_wildcards_escaped", async () => {
    for (const [i, n] of ["%", "M%", "_TN", "M\\TN"].entries()) {
      const r: any = await prepareWalletOrder(setup(), CTX, input({ network: n, phone_number: `024112002${i}` }))
      expect(r.code).toBe("unknown_package")
    }
  })

  it("schedule_text_includes_cap", async () => {
    vi.mocked(walletOrderPrice).mockResolvedValue(23.5)
    const r: any = await prepareWalletOrder(
      setup({ balance: 1 }),
      CTX,
      input({ phone_number: "0241110013", schedule: { type: "weekly", runAtTime: "08:00", runOnDays: [1] } }),
    )
    expect(r.refused).toBeUndefined()
    expect(r.display.title).toBe("Confirm scheduled order")
    expect(r.display.scheduleText).toContain("up to GHS 23.50 each time")
    expect(r.display.scheduleText).toContain("Monday")
  })
})
