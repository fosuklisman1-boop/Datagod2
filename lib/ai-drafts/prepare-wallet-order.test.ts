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
        eq(c: string, v: unknown) { filters.push((r) => r[c] === v); return b },
        ilike(c: string, v: string) { filters.push((r) => String(r[c]).toLowerCase() === v.toLowerCase()); return b },
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
