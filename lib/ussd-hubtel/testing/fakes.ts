// lib/ussd-hubtel/testing/fakes.ts
// Test-only fakes shared by router.test.ts and flows/*.test.ts. Never imported by production code.
import { DEFAULT_NETWORK_PREFIXES } from "@/lib/phone-format"
import type { HubtelUssdConfig } from "../config"
import type { RouterDeps } from "../flow-kit"
import type { AfaServices, AirtimeServices, NetworkPlansServices, PayBillsServices, PayBillsVerifyInput, RcServices } from "../services"
import type { BotContext } from "@/lib/bot-commission/context"
import type { BotBillOrderInput, BotBundleOrderInput, BotOrderResult } from "@/lib/bot-commission/orders"
import type { BillerKey } from "@/lib/bills/billers"
import type { StorefrontQuote } from "@/lib/cashback/quote"
import type { StorefrontBundle } from "@/lib/storefront-commission/bundles"
import type { ResolvedShopCode, ShopServices } from "../shop-services"
import type { HubtelRequest, HubtelSession } from "../types"

export const NEW_ID = "11111111-1111-1111-1111-111111111111"
export const OK_PKG = { price: 10, dealer_price: null, is_available: true }

export interface FakeSupabaseOpts {
  /** Row returned by .single()/.maybeSingle() for a table; wins over rows written by insert. */
  rows?: Record<string, unknown>
  /** Plan 1 aliases for rows.packages / rows.hubtel_transactions / rows.ussd_orders. */
  pkg?: unknown
  txRow?: unknown
  orderRow?: unknown
  /** The hubtel_transactions insert fails with a generic error. */
  txError?: boolean
  /** The hubtel_transactions insert hits a unique violation; this row is what the winner wrote. */
  txConflictRow?: unknown
  /** Tables whose insert(...).select().single() fails. */
  failInsert?: string[]
}

export function fakeSupabase(opts: FakeSupabaseOpts = {}) {
  const fixed: Record<string, unknown> = { ...(opts.rows ?? {}) }
  if (opts.pkg !== undefined) fixed.packages = opts.pkg
  if (opts.txRow !== undefined) fixed.hubtel_transactions = opts.txRow
  if (opts.orderRow !== undefined) fixed.ussd_orders = opts.orderRow
  const inserts: Record<string, any[]> = {}
  const updates: Array<{ table: string; patch: any }> = []
  // Successful inserts become readable, so a replayed CONFIRM sees what the first one wrote.
  const stored: Record<string, unknown> = {}
  const read = async (table: string) => ({ data: fixed[table] ?? stored[table] ?? null, error: null })

  const client: any = {
    from(table: string) {
      const b: any = {
        select() { return b }, eq() { return b }, is() { return b }, not() { return b }, in() { return b },
        single: () => read(table),
        maybeSingle: () => read(table),
        insert(rows: any) {
          const list = ([] as any[]).concat(rows)
          ;(inserts[table] ??= []).push(...list)
          const isTx = table === "hubtel_transactions"
          const conflict = isTx && opts.txConflictRow !== undefined
          const failed = (opts.failInsert ?? []).includes(table)
          if (conflict) stored[table] = opts.txConflictRow
          else if (!(isTx && opts.txError) && !failed) stored[table] = { ...list[0], state: "awaiting_payment" }
          const txErr = conflict ? { code: "23505", message: "duplicate key value violates unique constraint" }
            : isTx && opts.txError ? { message: "boom" } : null
          const ib: any = {
            select() { return ib },
            single: async () => (failed ? { data: null, error: { message: "insert failed" } } : { data: { id: NEW_ID }, error: null }),
            then: (res: any) => res({ error: txErr }),
          }
          return ib
        },
        update(patch: any) { updates.push({ table, patch }); return b },
        then: (res: any) => res({ error: null }),
      }
      return b
    },
  }
  return { client, inserts, updates }
}

export function makeDeps(over: Partial<RouterDeps> = {}, sup = fakeSupabase({ pkg: OK_PKG })) {
  const store = new Map<string, HubtelSession>()
  const deps: RouterDeps = {
    supabase: sup.client,
    getConfig: async () => ({ welcome: "Welcome to Clingshub", welcomeCustom: false, brandName: "Clingshub", enabled: true, mode: "main", visibility: { data: true, afa: true, airtime: true, resultsChecker: true, networkPlans: true, payBills: true } }),
    sessions: {
      get: async id => store.get(id) ?? null,
      set: async (id, s) => { store.set(id, s) },
      del: async id => { store.delete(id) },
    },
    fetchBundles: async () => ({ bundles: [{ id: "pkg-1", size: "5", price: 10 }], total: 1 }),
    resolveCaller: async () => ({ effectivePriceTier: "regular" }),
    isDataBlocked: async () => false,
    getPrefixConfig: async () => ({ enabled: true, map: DEFAULT_NETWORK_PREFIXES }),
    pageSize: 5,
    resolveDialer: async () => ({}),
    airtime: fakeAirtime(),
    rc: fakeRc(),
    afa: fakeAfa(),
    shop: fakeShop(),
    networkPlans: fakeNetworkPlans(),
    payBills: fakePayBills(),
    ...over,
  }
  return { deps, store, sup }
}

export const req = (over: Partial<HubtelRequest>): HubtelRequest => ({
  Type: "Response", Mobile: "233200585542", SessionId: "S1", ServiceCode: "713",
  Message: "", Operator: "vodafone", Sequence: 2, ClientState: "", Platform: "USSD", ...over,
})

/** The digit for `label` in a numbered menu ("2. Buy Airtime" -> "2"). Numbering depends on which services are visible. */
export function digitFor(menu: string, label: string): string {
  const line = menu.split("\n").find(l => l.replace(/^\d+\.\s*/, "") === label)
  if (!line) throw new Error(`"${label}" not in menu:\n${menu}`)
  return line.split(".")[0]
}

export function fakeAirtime(over: Partial<AirtimeServices> = {}): AirtimeServices {
  return { isEnabled: async () => true, getLimits: async () => ({ min: 1, max: 500 }), feeRate: async () => 5, cashbackQuote: async () => null, ...over }
}

export function fakeRc(over: Partial<RcServices> = {}): RcServices {
  return {
    isBoardEnabled: async () => true,
    availableCount: async () => 10,
    maxQuantity: async () => 50,
    bulkHint: async () => null,
    price: async (_board, qty) => ({ unitPrice: 20, totalPaid: 20 * qty, bulkApplied: false }),
    listMyVouchers: async () => [],
    resendVouchers: async () => ({ success: true, message: "ok" }),
    checkSettings: async () => ({ enabled: true, fee: 2 }),
    ...over,
  }
}

export const BOT_ORDER_ID = "22222222-3333-4444-8555-666666666666"

/** Bundle plans for the fake Network Plans catalog: `n` plans in `category`, face 10+i, pay 9.5+i. */
export function fakePlans(category: string, n: number, display = (i: number) => `${i + 1}GB`): StorefrontBundle[] {
  return Array.from({ length: n }, (_, i) => ({
    value: `v${i}`, display: display(i), amount: 10 + i, category, token: `tok-${category}-${i}`,
    payAmount: 9.5 + i, customerCashback: 0.5, paymentFee: 0,
  }))
}

/**
 * Network Plans engine fake. Default catalog: MTN-style "Video" + "Data" categories (out of CATEGORY_ORDER
 * order on purpose). createOrder dedupes by idempotency key like the engine; `createResult` overrides it.
 */
export function fakeNetworkPlans(over: Partial<NetworkPlansServices> & { createResult?: BotOrderResult } = {}) {
  const calls: { ctx: BotContext; input: BotBundleOrderInput }[] = []
  const byKey = new Map<string, BotOrderResult>()
  const { createResult, ...rest } = over
  const svc: NetworkPlansServices & { calls: typeof calls } = {
    calls,
    catalog: async () => ({ ok: true, categories: [{ name: "Video", bundles: fakePlans("Video", 2) }, { name: "Data", bundles: fakePlans("Data", 7) }] }),
    createOrder: async (ctx, input) => {
      calls.push({ ctx, input })
      if (createResult) return createResult
      const key = String(input.idempotencyKey)
      const prior = byKey.get(key)
      if (prior) return prior
      const r: BotOrderResult = {
        ok: true,
        order: { id: BOT_ORDER_ID, reference: "SB-1", payAmount: Number(input.expectedPay), faceAmount: 10, customerCashback: 0.5, paymentFee: 0 },
      }
      byKey.set(key, r)
      return r
    },
    ...rest,
  }
  return svc
}

/** ECG meters linked to the fake's phones (local form). Any other phone has none. */
export const FAKE_ECG_METERS: Record<string, { meter: string; name: string | null; outstanding: number | null }[]> = {
  "0244123456": [
    { meter: "P1234567", name: "Kof*** Men***", outstanding: 12.5 },
    { meter: "P7654321", name: null, outstanding: null },
  ],
}

/**
 * Pay Bills engine fake: every biller enabled (Ghana Water included, so the flow must drop it), GHS 1–1000.
 * verify follows botVerifyBill's shapes (ECG phone lookup => meters with tokens; addMeter / other billers => one
 * token); quote takes 2% off the face; createOrder dedupes on the verify token like the engine; `createResult`
 * overrides it. Calls are recorded.
 */
export function fakePayBills(over: Partial<PayBillsServices> & { createResult?: BotOrderResult } = {}) {
  const calls = {
    verify: [] as { ctx: BotContext; input: PayBillsVerifyInput }[],
    quote: [] as { ctx: BotContext; biller: string; face: number }[],
    create: [] as { ctx: BotContext; input: BotBillOrderInput }[],
  }
  const byToken = new Map<string, BotOrderResult>()
  const { createResult, ...rest } = over
  const svc: PayBillsServices & { calls: typeof calls } = {
    calls,
    billers: async () => ["ecg", "ghana_water", "dstv", "gotv", "startimes", "telecel_broadband"].map(k => ({ key: k as BillerKey, min: 1, max: 1000 })),
    verify: async (ctx, input) => {
      calls.verify.push({ ctx, input })
      if (input.biller === "ecg" && !input.addMeter) {
        const meters = (FAKE_ECG_METERS[String(input.phone)] ?? []).map(m => ({ ...m, token: `tok-ecg-${m.meter}` }))
        return { ok: true, customerName: null, amountDue: null, suggestedAmount: 0, meters }
      }
      if (input.biller === "ecg") return { ok: true, customerName: null, amountDue: null, suggestedAmount: 0, token: `tok-ecg-${input.account}` }
      return { ok: true, customerName: "Ama*** Ser***", amountDue: 45.5, suggestedAmount: 45.5, token: `tok-${input.biller}-${input.account}` }
    },
    quote: async (ctx, biller, face) => {
      calls.quote.push({ ctx, biller, face })
      const pay = Math.round(face * 98) / 100
      return { applied: true, faceAmount: face, payAmount: pay, customerCashback: Math.round((face - pay) * 100) / 100 } as StorefrontQuote
    },
    createOrder: async (ctx, input) => {
      calls.create.push({ ctx, input })
      if (createResult) return createResult
      const key = String(input.token)
      const prior = byToken.get(key)
      if (prior) return prior
      const r: BotOrderResult = {
        ok: true,
        order: { id: BOT_ORDER_ID, reference: "BILL-1", payAmount: Number(input.expectedPay), faceAmount: Number(input.amount), customerCashback: 0, paymentFee: 0 },
      }
      byToken.set(key, r)
      return r
    },
    ...rest,
  }
  return svc
}

export function fakeAfa(over: Partial<AfaServices> = {}): AfaServices {
  return { getPrice: async () => 50, ...over }
}

/** Shop mode, every service visible. */
export const SHOP_CONFIG = async (): Promise<HubtelUssdConfig> => ({
  enabled: true, mode: "shop", visibility: { data: true, afa: true, airtime: true, resultsChecker: true, networkPlans: true, payBills: true }, welcome: "Welcome to Clingshub", welcomeCustom: false, brandName: "Clingshub",
})

/** An active shop code owned by a regular (non-sub-agent) shop. tokenBalance is unused since 2026-10-14. */
export const SHOP_CODE: ResolvedShopCode = {
  shopCodeId: "code-1", shopId: "shop-1", shopName: "Ama Data Hub", parentShopId: null,
  status: "active", tokenBalance: 50, whatsappActivated: false,
}

/** Shop lookups. Only code "1234" resolves (to SHOP_CODE). Numbers are chosen for readable assertions. */
export function fakeShop(over: Partial<ShopServices> = {}): ShopServices {
  return {
    resolveCode: async code => (code === "1234" ? { ...SHOP_CODE } : null),
    networks: async () => ["MTN", "Telecel"],
    bundles: async () => [{ id: "pkg-1", size: "5", price: 12 }],
    verifyBundlePrice: async () => ({ verifiedPrice: 12, profitAmount: 2, parentProfitAmount: 0 }),
    orderContext: async () => ({ shopName: "Ama Data Hub Ltd", customerEmail: "0200585542@ussd.datagod.com", shopOwnerEmail: "owner@example.com" }),
    airtimeFeeRate: async () => ({ totalFeeRate: 7, merchantCommissionRate: 2 }),
    rcPrice: async (_board, qty) => ({ unitPrice: 22, totalPaid: 22 * qty, bulkApplied: false, merchantCommission: 2 * qty }),
    ...over,
  }
}

