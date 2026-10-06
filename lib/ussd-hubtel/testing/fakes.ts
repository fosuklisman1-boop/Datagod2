// lib/ussd-hubtel/testing/fakes.ts
// Test-only fakes shared by router.test.ts and flows/*.test.ts. Never imported by production code.
import { DEFAULT_NETWORK_PREFIXES } from "@/lib/phone-format"
import type { RouterDeps } from "../flow-kit"
import type { AfaServices, AirtimeServices, RcServices } from "../services"
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
    getConfig: async () => ({ enabled: true, mode: "main", visibility: { data: true, afa: true, airtime: true, resultsChecker: true } }),
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
  return { isEnabled: async () => true, getLimits: async () => ({ min: 1, max: 500 }), feeRate: async () => 5, ...over }
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

export function fakeAfa(over: Partial<AfaServices> = {}): AfaServices {
  return { getPrice: async () => 50, ...over }
}
