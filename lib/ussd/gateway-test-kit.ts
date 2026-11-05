// Test-only kit for the USSD gateway tests (not a test file itself). The REAL startMomoCharge runs against it: only
// the gateway config, Hubtel readiness, the relay client, the alert sender and Supabase are replaced, so nothing ever
// reaches a database, the relay, Paystack or Hubtel.
//
// Use from a test file:
//   vi.mock("@supabase/supabase-js", async () => (await import("@/lib/ussd/gateway-test-kit")).supabaseMock())
//   vi.mock("@/lib/payment-gateway/read-config", async () => (await import("@/lib/ussd/gateway-test-kit")).readConfigMock())
//   vi.mock("@/lib/payment-gateway/hubtel-readiness", async () => (await import("@/lib/ussd/gateway-test-kit")).readinessMock())
//   vi.mock("@/lib/hubtel-pay/client", async (orig) => (await import("@/lib/ussd/gateway-test-kit")).relayMock(await orig()))
//   vi.mock("@/lib/hubtel-pay/alert-throttle", async () => (await import("@/lib/ussd/gateway-test-kit")).alertMock())
import { vi } from "vitest"

type Row = Record<string, any>

const OPEN = ["pending", "confirming"]

export const kit = {
  db: {} as Record<string, Row[]>,
  config: null as any,
  ready: true,
  nextId: 1,
  /** Tables whose updates fail (error returned). */
  failUpdates: [] as string[],
  /** What the relay answers to a receive call. */
  receive: vi.fn(async (_p: any): Promise<any> => ({ kind: "accepted" })),
  alerts: [] as string[],
  /** Every insert / update, in order, as [table, op]. */
  ops: [] as [string, string][],
}

export function resetKit(): void {
  kit.db = {}
  kit.config = gatewayConfig()
  kit.ready = true
  kit.nextId = 1
  kit.failUpdates = []
  kit.alerts = []
  kit.ops = []
  kit.receive.mockReset()
  kit.receive.mockImplementation(async () => ({ kind: "accepted" }))
}

/** Every surface on Paystack, except those listed, which are on Hubtel. */
export function gatewayConfig(hubtel: string[] = [], feeBearer = "customer"): any {
  const surfaces: Record<string, any> = {}
  for (const s of ["wallet_topup", "storefront", "dashboard_direct", "sms", "ussd", "whatsapp"]) {
    surfaces[s] = { gateway: hubtel.includes(s) ? "hubtel" : "paystack", mode: "direct", feeBearer }
  }
  return { version: 1, surfaces, hubtelFeePercent: 2 }
}

export const rows = (table: string): Row[] => (kit.db[table] ??= [])
export const hubtelRows = (): Row[] => rows("hubtel_payments")

function query(table: string) {
  const filters: ((r: Row) => boolean)[] = []
  let mode: "select" | "insert" | "update" = "select"
  let patch: Row = {}
  let inserted: Row[] = []
  let error: any = null
  let limitTo: number | null = null
  const matching = () => {
    const hit = rows(table).filter((r) => filters.every((f) => f(r)))
    return limitTo === null ? hit : hit.slice(0, limitTo)
  }
  const run = () => {
    if (mode === "insert") return { data: error ? null : inserted, error }
    if (mode === "update") {
      if (kit.failUpdates.includes(table)) return { data: null, error: { code: "XX000", message: "update failed" } }
      const hit = matching()
      hit.forEach((r) => Object.assign(r, patch))
      return { data: hit, error: null }
    }
    return { data: matching(), error: null }
  }
  const c: any = {}
  for (const m of ["select", "or", "order", "not", "lte", "gt", "lt", "neq"]) c[m] = () => c
  c.eq = (k: string, v: unknown) => (filters.push((r) => r[k] === v || (typeof v === "number" && Number(r[k]) === v)), c)
  c.is = (k: string, v: unknown) => (filters.push((r) => (r[k] ?? null) === v), c)
  c.in = (k: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[k])), c)
  c.gte = (k: string, v: string) => (filters.push((r) => String(r[k]) >= v), c)
  c.limit = (n: number) => ((limitTo = n), c)
  c.range = async (a: number, b: number) => ({ data: matching().slice(a, b + 1), error: null, count: matching().length })
  c.insert = (input: Row | Row[]) => {
    mode = "insert"
    kit.ops.push([table, "insert"])
    inserted = (Array.isArray(input) ? input : [input]).map((r) => ({
      id: `${table}-${kit.nextId++}`, created_at: new Date().toISOString(), ...r,
    }))
    if (table === "hubtel_payments" && inserted.some((n) => rows(table).some((r) => r.internal_reference === n.internal_reference && OPEN.includes(r.status ?? "pending")))) {
      error = { code: "23505", message: "duplicate" }
    } else {
      if (table === "hubtel_payments") inserted.forEach((r) => (r.status ??= "pending"))
      rows(table).push(...inserted)
    }
    return c
  }
  c.update = (p: Row) => ((mode = "update"), (patch = p), kit.ops.push([table, "update"]), c)
  c.single = async () => {
    const { data, error: e } = run()
    return { data: data?.[0] ?? null, error: e ?? (data?.[0] ? null : { message: "no rows" }) }
  }
  c.maybeSingle = async () => {
    const { data, error: e } = run()
    return { data: data?.[0] ?? null, error: e }
  }
  c.then = (res: any, rej: any) => Promise.resolve(run()).then(res, rej)
  return c
}

export const fakeClient = {
  from: query,
  rpc: async (fn: string, args: any) => {
    if (fn === "claim_hubtel_payment") {
      const r = hubtelRows().find((x) => x.reference === args.p_reference && x.status === "pending")
      if (!r) return { data: [], error: null }
      r.status = "confirming"
      r.claimed_at = "claimed"
      return { data: [{ reference: r.reference, claimed_at: r.claimed_at }], error: null }
    }
    return { data: null, error: null }
  },
}

export const supabaseMock = () => ({ createClient: () => fakeClient })
export const readConfigMock = () => ({
  getGatewayConfig: async () => kit.config,
  getSurfaceConfig: async (s: string) => kit.config.surfaces[s],
})
export const readinessMock = () => ({ isHubtelCollectionReady: () => kit.ready })
export const relayMock = (orig: any) => ({
  ...orig,
  receiveMoney: (p: any) => kit.receive(p),
  initiateCheckout: vi.fn(),
  checkPaymentStatus: async () => ({ kind: "not_found", raw: {} }),
  hubtelCallbackUrl: (r: string) => `https://www.example.com/cb?ref=${r}`,
  hubtelReturnUrl: (r: string) => `https://www.example.com/rt?ref=${r}`,
})
export const alertMock = () => ({ sendThrottledAlert: vi.fn(async (_db: unknown, message: string) => { kit.alerts.push(message) }) })
