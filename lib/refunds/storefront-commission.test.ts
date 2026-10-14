import { describe, expect, it, vi } from "vitest"
import { loadRefundableOrders, listPendingOrderRefs, isStorefrontRow } from "./orders"
import { evaluateEligibility, orderEligibility, refundableStatuses } from "./eligibility"
import { executeRefund, executeManualRefund, manualNoteText, mapReserveError, previewRefund, MANUAL_GATEWAY, type RefundDeps } from "./service"
import { notifyRefund } from "./notify"
import { REFUND_STATUS } from "./http"
import { walletGateway } from "./gateways/wallet"
import { paystackGateway } from "./gateways/paystack"
import { moolreGateway } from "./gateways/moolre"
import type { CommissionEvidence, CommissionLedgerFact, CommissionTable, RefundableOrder, RefundGateway } from "./types"
import { isBeforeStorefrontRefunds, STOREFRONT_REFUNDS_FROM } from "./types"

vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ rpc: vi.fn() }) }))
const sendSMS = vi.fn(async () => ({}))
vi.mock("@/lib/sms-service", () => ({ sendSMS: (...a: unknown[]) => (sendSMS as any)(...a), notifyAdmins: vi.fn(async () => {}) }))
vi.mock("@/lib/paystack", () => ({ refundTransaction: vi.fn(), fetchRefund: vi.fn() }))
vi.mock("@/lib/moolre-transfer", () => ({ initiateTransfer: vi.fn(), getTransferStatus: vi.fn() }))
vi.mock("@/lib/paystack-transfer", () => ({
  createRecipient: vi.fn(), initiateTransfer: vi.fn(), finalizeTransfer: vi.fn(), getTransferStatus: vi.fn(),
  mapNetworkToPaystackBankCode: (n: string) => ({ MTN: "MTN", TELECEL: "VOD", AT: "ATL" } as Record<string, string>)[n.toUpperCase()],
}))

const NOW = Date.parse("2026-10-14T12:00:00Z")
const ago = (ms: number) => new Date(NOW - ms).toISOString()

// ───────────────────────────── loader ─────────────────────────────

type Rows = Record<string, unknown[]>
function fakeDb(rows: Rows, calls: unknown[][] = []) {
  const make = (table: string) => {
    const rec = (m: string) => (...a: unknown[]) => { calls.push([table, m, ...a]); return q }
    const q: any = {
      select: rec("select"), eq: rec("eq"), in: rec("in"), is: rec("is"), neq: rec("neq"), not: rec("not"), gte: rec("gte"),
      order: rec("order"), range: rec("range"), limit: rec("limit"), or: rec("or"),
      then: (res: (v: unknown) => unknown) => Promise.resolve({ data: rows[table] ?? [], error: null }).then(res),
    }
    return q
  }
  return { from: (t: string) => make(t) } as any
}

describe("loadRefundableOrders: storefront commission tables", () => {
  it("airtime: paid = total_paid, Paystack ref from the completed wallet_payments row, payer from payment_attempts, no wallet, merchant share as owner cut", async () => {
    const calls: unknown[][] = []
    const db = fakeDb({
      airtime_orders: [{
        id: "a1", shop_id: "shopA", user_id: null, channel: null, dialing_phone: null, network: "MTN", beneficiary_phone: "0249999999",
        airtime_amount: 10, total_paid: 10.13, status: "pending", payment_status: "completed", notes: null,
        created_at: "2026-10-14T10:00:00Z", updated_at: "2026-10-14T10:00:00Z",
      }],
      wallet_payments: [
        { order_id: "a1", reference: "OLD", amount: 10.13, fee: 0, status: "pending" },
        { order_id: "a1", reference: "REF-A", amount: 10.13, fee: 0, status: "completed" },
      ],
      payment_attempts: [{ reference: "REF-A", payer_phone: "+233241112222" }],
      shop_profits: [{ shop_id: "shopA", profit_amount: 0.15, status: "credited", airtime_order_id: "a1" }],
      user_shops: [{ id: "shopA", shop_name: "Alpha", user_id: "uA" }],
      shop_available_balance: [{ shop_id: "shopA", available_balance: 5 }],
      wallets: [{ user_id: "uA", balance: 1 }],
      order_refunds: [], hubtel_cs_transactions: [],
    }, calls)
    const [o] = await loadRefundableOrders(db, [{ table: "airtime_orders", id: "a1" }])
    expect(o.paid).toBe(10.13)
    expect(o.gatewayFee).toBe(0)
    expect(o.payment).toEqual({ gateway: "paystack", reference: "REF-A", payerPhone: "0241112222", walletUserId: null })
    expect(o.recipientPhone).toBe("0249999999")
    expect(o.owners).toEqual([{ shopId: "shopA", ownerUserId: "uA", credited: 0.15, pending: 0, availableBalance: 5, walletBalance: 1 }])
    expect(o.evidence.commission).toMatchObject({ storefront: true, status: "pending", paymentStatus: "completed" })
    // the clawback link column + the ledger is read for THIS table only
    expect(calls).toContainEqual(["shop_profits", "in", "airtime_order_id", ["a1"]])
    expect(calls).toContainEqual(["hubtel_cs_transactions", "eq", "order_table", "airtime_orders"])
  })

  it("airtime: never pays out to the beneficiary when no payer number was recorded", async () => {
    const db = fakeDb({
      airtime_orders: [{ id: "a1", shop_id: "s", user_id: null, channel: null, network: "MTN", beneficiary_phone: "0249999999", airtime_amount: 10, total_paid: 10, status: "pending", payment_status: "completed", created_at: "x", updated_at: "x" }],
      wallet_payments: [{ order_id: "a1", reference: "REF-A", amount: 10, fee: 0, status: "completed" }],
    })
    const [o] = await loadRefundableOrders(db, [{ table: "airtime_orders", id: "a1" }])
    expect(o.payment.payerPhone).toBeNull()
  })

  it("bill: paid = paid_amount (not the face amount), ref = payment_reference, payer = buyer phone, 'paid' normalised, ledger newest first", async () => {
    const db = fakeDb({
      hubtel_bill_orders: [{
        id: "b1", shop_id: "shopA", user_id: null, channel: "storefront", biller: "ecg", account_number: "123456",
        amount: 100, paid_amount: 101.82, status: "failed", payment_status: "paid", hubtel_client_reference: "HCS-2",
        notes: null, buyer_phone: "233241112222", payment_reference: "abc123", created_at: "2026-10-14T10:00:00Z", updated_at: "2026-10-14T10:00:00Z",
      }],
      wallet_payments: [{ order_id: "b1", reference: "abc123", amount: 101.82, fee: 0, status: "completed" }],
      hubtel_cs_transactions: [
        { order_id: "b1", client_reference: "HCS-1", state: "failed", refund_claimed_at: null, resolved_by: null, created_at: "2026-10-14T10:01:00Z" },
        { order_id: "b1", client_reference: "HCS-2", state: "failed", refund_claimed_at: null, resolved_by: null, created_at: "2026-10-14T10:05:00Z" },
      ],
    })
    const [o] = await loadRefundableOrders(db, [{ table: "hubtel_bill_orders", id: "b1" }])
    expect(o.paid).toBe(101.82)
    expect(o.paymentStatus).toBe("completed")
    expect(o.payment).toEqual({ gateway: "paystack", reference: "abc123", payerPhone: "0241112222", walletUserId: null })
    expect(o.packageLabel).toBe("ECG Prepaid & Postpaid bill")
    expect(o.evidence.commission?.ledger.map((l) => l.client_reference)).toEqual(["HCS-2", "HCS-1"])
    expect(o.evidence.commission?.storefront).toBe(true)
  })

  it("bundle: legacy row without paid_amount falls back to amount; dashboard row is flagged not-storefront", async () => {
    const db = fakeDb({
      hubtel_data_orders: [{
        id: "d1", shop_id: null, user_id: "u1", channel: "dashboard", network: "MTN", bundle_display: "1GB", beneficiary_phone: "233241112222",
        amount: 12, paid_amount: null, status: "pending", payment_status: "paid", created_at: "x", updated_at: "x",
      }],
    })
    const [o] = await loadRefundableOrders(db, [{ table: "hubtel_data_orders", id: "d1" }])
    expect(o.paid).toBe(12)
    expect(o.evidence.commission?.storefront).toBe(false)
    expect(orderEligibility(o, NOW)).toMatchObject({ eligible: false, code: "NOT_STOREFRONT" })
  })

  it("isStorefrontRow: airtime = web storefront only (no account, no channel, no dialing phone)", () => {
    expect(isStorefrontRow("airtime_orders", { shop_id: "s", user_id: null, channel: null, dialing_phone: null })).toBe(true)
    expect(isStorefrontRow("airtime_orders", { shop_id: "s", user_id: "u", channel: null })).toBe(false) // wallet-paid
    expect(isStorefrontRow("airtime_orders", { shop_id: "s", user_id: null, channel: "ussd_shop" })).toBe(false)
    expect(isStorefrontRow("airtime_orders", { shop_id: "s", user_id: null, channel: null, dialing_phone: "024" })).toBe(false)
    expect(isStorefrontRow("airtime_orders", { shop_id: null, user_id: null, channel: null })).toBe(false)
    expect(isStorefrontRow("hubtel_bill_orders", { channel: "storefront" })).toBe(true)
    expect(isStorefrontRow("hubtel_bill_orders", { channel: "dashboard" })).toBe(false)
  })
})

describe("listPendingOrderRefs: storefront commission tables", () => {
  it("lists only paid storefront rows", async () => {
    const calls: unknown[][] = []
    const db = fakeDb({ airtime_orders: [{ id: "a1", created_at: "2026-10-14T10:00:00Z" }], hubtel_bill_orders: [], hubtel_data_orders: [] }, calls)
    const r = await listPendingOrderRefs(db, { pageSize: 10, page: 1, table: "airtime_orders" })
    expect(r).toEqual([{ table: "airtime_orders", id: "a1", createdAt: "2026-10-14T10:00:00Z" }])
    expect(calls).toContainEqual(["airtime_orders", "not", "shop_id", "is", null])
    expect(calls).toContainEqual(["airtime_orders", "is", "user_id", null])
    expect(calls).toContainEqual(["airtime_orders", "eq", "payment_status", "completed"])
    expect(calls).toContainEqual(["airtime_orders", "in", "status", ["pending", "failed"]])
    // storefront airtime from before the launch was refunded out of band: never listed
    expect(STOREFRONT_REFUNDS_FROM).toBe("2026-10-14T00:00:00Z")
    expect(calls).toContainEqual(["airtime_orders", "gte", "created_at", STOREFRONT_REFUNDS_FROM])
    calls.length = 0
    await listPendingOrderRefs(db, { pageSize: 10, page: 1, table: "hubtel_bill_orders", shopId: "shopA" })
    expect(calls).toContainEqual(["hubtel_bill_orders", "eq", "channel", "storefront"])
    expect(calls).toContainEqual(["hubtel_bill_orders", "eq", "payment_status", "paid"])
    expect(calls).toContainEqual(["hubtel_bill_orders", "eq", "shop_id", "shopA"])
    expect(calls.some((c) => c[1] === "gte")).toBe(false) // the cutoff is airtime-only
  })
  it("refundable statuses mirror the RPC", () => expect(refundableStatuses("hubtel_data_orders")).toEqual(["pending", "failed"]))
})

// ───────────────────────────── eligibility ─────────────────────────────

const led = (o: Partial<CommissionLedgerFact> = {}): CommissionLedgerFact => ({
  client_reference: "HCS-1", state: "failed", refund_claimed_at: null, resolved_by: null, created_at: ago(600_000), ...o,
})
const ev = (o: Partial<CommissionEvidence> = {}): CommissionEvidence => ({
  storefront: true, status: "failed", paymentStatus: "paid", hubtelClientReference: null, notes: null, updatedAt: ago(600_000), ledger: [], ...o,
})
const elig = (table: CommissionTable, c: CommissionEvidence, hasActiveRefund = false) =>
  evaluateEligibility({ table, orderStatus: c.status, paymentStatus: "completed", hasActiveRefund, dispatchOutcome: null, trackingStatuses: [], externalOrderId: null, commission: c, now: NOW })

describe("storefront commission eligibility", () => {
  for (const table of ["hubtel_bill_orders", "hubtel_data_orders"] as const) {
    describe(table, () => {
      it("blocks while the Hubtel ledger row is created / pending / needs_review", () => {
        for (const state of ["created", "pending", "needs_review"] as const) {
          const r = elig(table, ev({ status: "processing", hubtelClientReference: "HCS-1", ledger: [led({ state })] }))
          expect(r).toMatchObject({ eligible: false, code: "HUBTEL_BLOCKED" })
        }
        // even when the order itself says failed
        expect(elig(table, ev({ ledger: [led({ state: "pending" })] })).eligible).toBe(false)
      })
      it("blocks once delivered (ledger fulfilled or order completed)", () => {
        expect(elig(table, ev({ ledger: [led({ state: "fulfilled" })] })).eligible).toBe(false)
        expect(elig(table, ev({ status: "completed" })).eligible).toBe(false)
      })
      it("never-sent: a pending paid order is refundable only after 60 s", () => {
        expect(elig(table, ev({ status: "pending", updatedAt: ago(59_000) })).eligible).toBe(false)
        expect(elig(table, ev({ status: "pending", updatedAt: ago(61_000) }))).toEqual({ eligible: true })
      })
      it("a stuck claim (>= 5 min, no ledger) is refundable after a release", () => {
        const stuck = ev({ status: "processing", notes: "Dispatching to Hubtel", updatedAt: ago(5 * 60_000 + 1) })
        expect(elig(table, stuck)).toEqual({ eligible: true, releaseStuck: true })
        expect(elig(table, { ...stuck, updatedAt: ago(4 * 60_000) }).eligible).toBe(false)
      })
      it("failed at Hubtel (all ledger rows failed, order failed) is refundable; a claimed ledger refund is not", () => {
        expect(elig(table, ev({ hubtelClientReference: "HCS-1", ledger: [led()] }))).toEqual({ eligible: true })
        expect(elig(table, ev({ hubtelClientReference: "HCS-1", ledger: [led({ refund_claimed_at: ago(1000) })] })).eligible).toBe(false)
      })
      it("never paid / already refunded / an active refund / not storefront", () => {
        expect(elig(table, ev({ paymentStatus: "unpaid" })).eligible).toBe(false)
        expect(elig(table, ev({ status: "refunded", paymentStatus: "refunded" })).eligible).toBe(false)
        expect(elig(table, ev(), true)).toMatchObject({ eligible: false, code: "ALREADY_REFUNDED" })
        expect(elig(table, ev({ storefront: false }))).toMatchObject({ eligible: false, code: "NOT_STOREFRONT" })
      })
    })
  }

  describe("airtime_orders", () => {
    const air = (o: Partial<CommissionEvidence> = {}) => ev({ status: "pending", paymentStatus: "completed", ...o })
    it("pending after a Hubtel failure (all ledger rows failed) is refundable", () => {
      expect(elig("airtime_orders", air({ ledger: [led()] }))).toEqual({ eligible: true })
    })
    it("blocks while a Hubtel row is live, and after delivery", () => {
      expect(elig("airtime_orders", air({ ledger: [led({ state: "needs_review" })] }))).toMatchObject({ eligible: false, code: "PROVIDER_IN_PROGRESS" })
      expect(elig("airtime_orders", air({ ledger: [led({ state: "created" })] })).eligible).toBe(false)
      expect(elig("airtime_orders", air({ ledger: [led({ state: "fulfilled" })] }))).toMatchObject({ eligible: false, code: "SENT_TO_PROVIDER" })
      expect(elig("airtime_orders", air({ status: "completed" }))).toMatchObject({ eligible: false, code: "SENT_TO_PROVIDER" })
    })
    it("blocks a recorded Digiwapy send (pending) until an admin marks it failed", () => {
      for (const notes of ["Auto-fulfilled via Digiwapy [dgwRef:DW1]", "Auto-fulfilled via Digiwapy", "Digiwapy: transaction.failed (x)", "Digiwapy error: timeout"]) {
        expect(elig("airtime_orders", air({ notes }))).toMatchObject({ eligible: false, code: "PROVIDER_IN_PROGRESS" })
        expect(elig("airtime_orders", air({ notes, status: "failed" })).eligible).toBe(true)
      }
    })
    it("blocks a recorded Hubtel ref with no ledger row; allows it when the ledger shows it failed", () => {
      const notes = "Hubtel failed: x [hcsRef:HCS-9]. Fulfil manually; not resent."
      expect(elig("airtime_orders", air({ notes })).eligible).toBe(false)
      expect(elig("airtime_orders", air({ notes, ledger: [led({ client_reference: "HCS-9" })] })).eligible).toBe(true)
    })
    it("blocks processing and unpaid; 60 s never-sent grace on pending", () => {
      expect(elig("airtime_orders", air({ status: "processing" })).eligible).toBe(false)
      expect(elig("airtime_orders", air({ paymentStatus: "pending_payment" })).eligible).toBe(false)
      expect(elig("airtime_orders", air({ updatedAt: ago(30_000) })).eligible).toBe(false)
      expect(elig("airtime_orders", air({ status: "failed", updatedAt: ago(1_000) })).eligible).toBe(true)
    })
    it("orders created before STOREFRONT_REFUNDS_FROM are not refundable here; at/after the cutoff they are", () => {
      expect(elig("airtime_orders", air({ status: "failed", createdAt: "2026-10-13T23:59:59Z" }))).toMatchObject({ eligible: false, code: "BEFORE_LAUNCH" })
      expect(elig("airtime_orders", air({ status: "failed", createdAt: "2026-07-01T10:00:00Z" })).eligible).toBe(false)
      expect(elig("airtime_orders", air({ status: "failed", createdAt: STOREFRONT_REFUNDS_FROM })).eligible).toBe(true)
      expect(elig("airtime_orders", air({ status: "failed", createdAt: "2026-10-14T10:00:00Z" })).eligible).toBe(true)
      // unparseable creation time fails closed
      expect(elig("airtime_orders", air({ status: "failed", createdAt: "" })).eligible).toBe(false)
      expect(isBeforeStorefrontRefunds(null)).toBe(true)
      // bills/bundles are new tables: no cutoff
      expect(elig("hubtel_bill_orders", ev({ createdAt: "2026-07-01T10:00:00Z", hubtelClientReference: "HCS-1", ledger: [led()] })).eligible).toBe(true)
    })
  })
})

// ───────────────────────────── service ─────────────────────────────

const commissionOrder = (table: CommissionTable, o: Partial<RefundableOrder> = {}, c: Partial<CommissionEvidence> = {}): RefundableOrder => ({
  table, id: "o1", orderStatus: "failed", paymentStatus: "completed", shopId: "sA", shopName: "Alpha",
  packageLabel: "ECG bill", network: "(123)", recipientPhone: "0241112222", createdAt: "2026-10-14", paid: 101.82, gatewayFee: 0,
  payment: { gateway: "paystack", reference: "abc123", payerPhone: "0241112222", walletUserId: null },
  owners: [{ shopId: "sA", ownerUserId: "uA", credited: 0.27, pending: 0, availableBalance: 5, walletBalance: 0 }],
  evidence: {
    hasActiveRefund: false, dispatchOutcome: null, dispatchAttempts: null, trackingStatuses: [], externalOrderId: null,
    commission: ev(c),
  },
  ...o,
})

function setup(ord: RefundableOrder | null, reserveError?: string) {
  const calls: { name: string; args: any }[] = []
  const gateway: RefundGateway = { id: "paystack", label: "Paystack", supports: () => ({ ok: true }), refund: vi.fn(async () => ({ kind: "completed" as const, ref: "R1" })) }
  const deps: RefundDeps = {
    rpc: async (name, args) => {
      calls.push({ name, args })
      if (name === "reserve_order_refund") return reserveError ? { data: null, error: { message: reserveError } } : { data: { refund_id: "rf1", clawbacks: [] }, error: null }
      return { data: name === "complete_order_refund" ? "completed" : "failed", error: null }
    },
    loadOrder: async () => ord,
    getGateway: (id) => (id === "paystack" ? gateway : undefined),
    notify: vi.fn(async () => {}),
    now: () => NOW,
    releaseStuckClaim: vi.fn(async () => 1),
    markRefundMethod: vi.fn(async () => {}),
  }
  return { deps, calls, gateway }
}

describe("executeRefund: storefront commission orders", () => {
  it("passes exactly what the customer paid (paid_amount / total_paid) to reserve_order_refund", async () => {
    for (const table of ["airtime_orders", "hubtel_bill_orders", "hubtel_data_orders"] as const) {
      const { deps, calls } = setup(commissionOrder(table, { paid: 10.13 }, table === "airtime_orders" ? { status: "failed", paymentStatus: "completed" } : {}))
      const res = await executeRefund(deps, { table, orderId: "o1", gateway: "paystack", amount: 10.13, adminId: "admin1" })
      expect(res.status).toBe("completed")
      expect(calls[0]).toMatchObject({ name: "reserve_order_refund", args: { p_order_table: table, p_paid: 10.13, p_fee: 0, p_amount: 10.13, p_wallet_user: null } })
    }
  })

  it("surfaces BAD_CHANNEL from the RPC as a 409 with a clear message", async () => {
    const { deps } = setup(commissionOrder("hubtel_bill_orders"), "BAD_CHANNEL")
    const err = await executeRefund(deps, { table: "hubtel_bill_orders", orderId: "o1", gateway: "paystack", amount: 1, adminId: "a" }).catch((e) => e)
    expect(err.code).toBe("BAD_CHANNEL")
    expect(err.message).toMatch(/storefront/i)
    expect(REFUND_STATUS.BAD_CHANNEL).toBe(409)
    expect(mapReserveError("P0001: BAD_CHANNEL").code).toBe("BAD_CHANNEL")
  })

  it("never reserves while the Hubtel ledger is pending, nor after delivery", async () => {
    for (const c of [{ ledger: [led({ state: "pending" })] }, { ledger: [led({ state: "fulfilled" })] }, { status: "completed" }]) {
      const { deps, calls, gateway } = setup(commissionOrder("hubtel_data_orders", {}, c))
      await expect(executeRefund(deps, { table: "hubtel_data_orders", orderId: "o1", gateway: "paystack", amount: 1, adminId: "a" })).rejects.toMatchObject({ code: "NOT_ELIGIBLE" })
      expect(calls).toEqual([])
      expect(gateway.refund).not.toHaveBeenCalled()
    }
  })

  it("never-sent after 60 s: reserves straight from pending (the RPC flips it under the order lock)", async () => {
    const { deps, calls } = setup(commissionOrder("hubtel_bill_orders", { orderStatus: "pending" }, { status: "pending", updatedAt: ago(61_000) }))
    await executeRefund(deps, { table: "hubtel_bill_orders", orderId: "o1", gateway: "paystack", amount: 101.82, adminId: "a" })
    expect(calls.map((c) => c.name)).toEqual(["reserve_order_refund", "complete_order_refund"])
    expect(deps.releaseStuckClaim).not.toHaveBeenCalled()
  })

  it("stuck claim: releases (SQL-guarded) before reserving; a claim no longer stuck reserves nothing", async () => {
    const stuck = { status: "processing", notes: "Dispatching to Hubtel", updatedAt: ago(6 * 60_000) }
    const ok = setup(commissionOrder("hubtel_bill_orders", { orderStatus: "processing" }, stuck))
    await executeRefund(ok.deps, { table: "hubtel_bill_orders", orderId: "o1", gateway: "paystack", amount: 1, adminId: "a" })
    expect(ok.deps.releaseStuckClaim).toHaveBeenCalledWith("hubtel_bill_orders", "o1", "a")
    expect(ok.calls[0].name).toBe("reserve_order_refund")

    const gone = setup(commissionOrder("hubtel_bill_orders", { orderStatus: "processing" }, stuck))
    gone.deps.releaseStuckClaim = vi.fn(async () => 0)
    await expect(executeRefund(gone.deps, { table: "hubtel_bill_orders", orderId: "o1", gateway: "paystack", amount: 1, adminId: "a" })).rejects.toMatchObject({ code: "NOT_ELIGIBLE" })
    expect(gone.calls).toEqual([])
  })

  it("a reserve failing after a stuck-claim release says the claim was released", async () => {
    const stuck = { status: "processing", notes: "Dispatching to Hubtel", updatedAt: ago(6 * 60_000) }
    const s = setup(commissionOrder("hubtel_bill_orders", { orderStatus: "processing" }, stuck), "SHORTFALL:sA:0.27")
    const err = await executeRefund(s.deps, { table: "hubtel_bill_orders", orderId: "o1", gateway: "paystack", amount: 1, adminId: "a" }).catch((e) => e)
    expect(err.code).toBe("SHORTFALL")
    expect(err.message).toMatch(/claim was released.*pending again/)
    expect(err.detail).toMatchObject({ claimReleased: true, shopId: "sA" })
    // without a release the message is unchanged
    const plain = setup(commissionOrder("hubtel_bill_orders"), "SHORTFALL:sA:0.27")
    const e2 = await executeRefund(plain.deps, { table: "hubtel_bill_orders", orderId: "o1", gateway: "paystack", amount: 1, adminId: "a" }).catch((e) => e)
    expect(e2.message).not.toMatch(/released/)
  })

  it("an admin-overridden Hubtel failure is refundable with a warning", () => {
    const r = elig("hubtel_bill_orders", ev({ hubtelClientReference: "HCS-1", ledger: [led({ resolved_by: "admin9" })] }))
    expect(r).toMatchObject({ eligible: true, warning: expect.stringMatching(/admin override/) })
  })

  it("gateway refund of an admin-overridden Hubtel failure needs the explicit confirm (same as manual)", async () => {
    const c = { hubtelClientReference: "HCS-1", ledger: [led({ resolved_by: "admin9" })] }
    for (const confirmOverride of [undefined, false]) {
      const s = setup(commissionOrder("hubtel_bill_orders", {}, c))
      const err = await executeRefund(s.deps, { table: "hubtel_bill_orders", orderId: "o1", gateway: "paystack", amount: 1, adminId: "a", confirmOverride }).catch((e) => e)
      expect(err).toMatchObject({ code: "NOT_ELIGIBLE", detail: { code: "CONFIRM_REQUIRED", warning: expect.stringMatching(/admin override/) } })
      expect(s.calls).toEqual([])
      expect(s.gateway.refund).not.toHaveBeenCalled()
    }
    const ok = setup(commissionOrder("hubtel_bill_orders", {}, c))
    const res = await executeRefund(ok.deps, { table: "hubtel_bill_orders", orderId: "o1", gateway: "paystack", amount: 1, adminId: "a", confirmOverride: true })
    expect(res.status).toBe("completed")
    expect(ok.calls[0].name).toBe("reserve_order_refund")
  })

  it("preview offers Paystack + MoMo payout, never the wallet", async () => {
    const { deps } = setup(commissionOrder("hubtel_bill_orders"))
    deps.getGateway = (await import("./gateways")).getGateway
    const p = await previewRefund({ ...deps, getGateway: deps.getGateway }, { table: "hubtel_bill_orders", id: "o1" })
    expect(p.defaultAmount).toBe(101.82)
    const o = p.order
    expect(walletGateway.supports(o)).toMatchObject({ ok: false })
    expect(paystackGateway.supports(o)).toEqual({ ok: true })
    expect(moolreGateway.supports(o)).toEqual({ ok: true })
    expect(p.clawback.lines.map((l) => l.credited)).toEqual([0.27])
  })
})

// ───────────────────────────── manual refund ─────────────────────────────

/** Stateful fake of the refund RPCs: one active refund per order, the clawback counted per reserve. */
function manualSetup(initial: RefundableOrder) {
  let order = initial
  const state = { clawbacks: 0, refunds: [] as { id: string; gateway: string; status: string }[] }
  const calls: { name: string; args: any }[] = []
  const deps: RefundDeps = {
    rpc: async (name, args) => {
      calls.push({ name, args })
      if (name === "reserve_order_refund") {
        if (state.refunds.some((r) => r.status !== "failed")) return { data: null, error: { message: "ALREADY_REFUNDED" } }
        state.clawbacks += 1
        const id = `rf${state.refunds.length + 1}`
        state.refunds.push({ id, gateway: String(args.p_gateway), status: "reserved" })
        order = { ...order, orderStatus: "refunding", evidence: { ...order.evidence, hasActiveRefund: true } }
        return { data: { refund_id: id, clawbacks: [{ shop_id: "sA", owner_user_id: "uA", from_profit: 0.27, from_wallet: 0, credited: 0.27 }] }, error: null }
      }
      if (name === "complete_order_refund") {
        const r = state.refunds.find((x) => x.id === args.p_refund_id)!
        r.status = "completed"
        order = { ...order, orderStatus: "refunded" }
        return { data: "completed", error: null }
      }
      return { data: null, error: { message: "unexpected" } }
    },
    loadOrder: async () => order,
    getGateway: () => undefined,
    notify: vi.fn(async () => {}),
    now: () => NOW,
    findActiveRefund: async () => state.refunds.find((r) => r.status !== "failed") ?? null,
    markRefundMethod: vi.fn(async () => {}),
    releaseStuckClaim: vi.fn(async () => 1),
  }
  return { deps, calls, state, setOrder: (o: RefundableOrder) => { order = o } }
}

describe("executeManualRefund", () => {
  const input = { table: "hubtel_bill_orders" as const, orderId: "o1", note: "Sent back by MoMo on 14 Oct", adminId: "admin1" }

  it("records the refund via the ledger RPCs with gateway 'manual', full paid amount, clawback, refund_method", async () => {
    const m = manualSetup(commissionOrder("hubtel_bill_orders"))
    const r = await executeManualRefund(m.deps, input)
    expect(r).toMatchObject({ refundId: "rf1", status: "completed", alreadyRefunded: false })
    expect(m.calls.map((c) => c.name)).toEqual(["reserve_order_refund", "complete_order_refund"])
    expect(m.calls[0].args).toMatchObject({ p_gateway: MANUAL_GATEWAY, p_paid: 101.82, p_amount: 101.82, p_fee: 0, p_wallet_user: null, p_destination: null, p_admin: "admin1" })
    expect(m.calls[1].args.p_gateway_ref).toBe("manual: Sent back by MoMo on 14 Oct")
    expect(m.deps.markRefundMethod).toHaveBeenCalledWith("hubtel_bill_orders", "o1", "manual")
    expect(m.state.clawbacks).toBe(1)
    expect(m.deps.notify).toHaveBeenCalledTimes(1)
  })

  it("is idempotent: a second click changes nothing and claws back once", async () => {
    const m = manualSetup(commissionOrder("hubtel_bill_orders"))
    await executeManualRefund(m.deps, input)
    const second = await executeManualRefund(m.deps, input)
    expect(second).toMatchObject({ alreadyRefunded: true, refundId: null })
    expect(m.calls.filter((c) => c.name === "reserve_order_refund")).toHaveLength(1)
    expect(m.state.clawbacks).toBe(1)
  })

  it("a concurrent double click: the loser's reserve is refused and it reports a no-op", async () => {
    const m = manualSetup(commissionOrder("hubtel_bill_orders"))
    const stale = commissionOrder("hubtel_bill_orders")
    const [a, b] = await Promise.all([executeManualRefund(m.deps, input), (async () => {
      // second request read the order before the first reserved
      const d = { ...m.deps, loadOrder: vi.fn().mockResolvedValueOnce(stale).mockImplementation(m.deps.loadOrder) }
      return executeManualRefund(d, input)
    })()])
    expect([a.alreadyRefunded, b.alreadyRefunded].sort()).toEqual([false, true])
    expect(m.state.clawbacks).toBe(1)
  })

  it("finishes a reserved-but-unfinished manual refund without a second reserve", async () => {
    const m = manualSetup(commissionOrder("hubtel_bill_orders"))
    m.state.refunds.push({ id: "rf9", gateway: "manual", status: "reserved" })
    m.setOrder(commissionOrder("hubtel_bill_orders", { orderStatus: "refunding", evidence: { ...commissionOrder("hubtel_bill_orders").evidence, hasActiveRefund: true } }))
    const r = await executeManualRefund(m.deps, input)
    expect(r).toMatchObject({ refundId: "rf9", alreadyRefunded: false })
    expect(m.calls.map((c) => c.name)).toEqual(["complete_order_refund"])
  })

  it("refuses while another (gateway) refund is in progress", async () => {
    const m = manualSetup(commissionOrder("hubtel_bill_orders", { evidence: { ...commissionOrder("hubtel_bill_orders").evidence, hasActiveRefund: true } }))
    m.state.refunds.push({ id: "rf9", gateway: "paystack", status: "processing" })
    await expect(executeManualRefund(m.deps, input)).rejects.toMatchObject({ code: "ALREADY_REFUNDED" })
    expect(m.calls).toEqual([])
  })

  it("same eligibility as a gateway refund: Hubtel pending blocks; non-storefront and other tables refused", async () => {
    const pending = manualSetup(commissionOrder("hubtel_bill_orders", {}, { ledger: [led({ state: "pending" })] }))
    await expect(executeManualRefund(pending.deps, input)).rejects.toMatchObject({ code: "NOT_ELIGIBLE" })
    expect(pending.calls).toEqual([])
    const dash = manualSetup(commissionOrder("hubtel_bill_orders", {}, { storefront: false }))
    await expect(executeManualRefund(dash.deps, input)).rejects.toMatchObject({ code: "NOT_ELIGIBLE" })
    await expect(executeManualRefund(dash.deps, { ...input, table: "shop_orders" as any })).rejects.toMatchObject({ code: "GATEWAY_UNSUPPORTED" })
  })

  it("stores the full note durably on the order (and reports when it could not)", async () => {
    const m = manualSetup(commissionOrder("hubtel_bill_orders"))
    const recordManualNote = vi.fn(async () => {})
    const long = "x".repeat(500)
    await executeManualRefund({ ...m.deps, recordManualNote }, { ...input, note: long })
    expect(recordManualNote).toHaveBeenCalledWith("hubtel_bill_orders", "o1", long, "admin1")
    expect(manualNoteText(long, "admin1", "Failed via Hubtel [hcsRef:HCS-1]")).toBe(`Refunded manually by admin admin1: ${long}\nFailed via Hubtel [hcsRef:HCS-1]`)

    const m2 = manualSetup(commissionOrder("hubtel_bill_orders"))
    const r = await executeManualRefund({ ...m2.deps, recordManualNote: async () => { throw new Error("db") } }, input)
    expect(r.status).toBe("completed")
    expect(r.message).toMatch(/note could not be saved/)
  })

  it("an admin-overridden Hubtel failure needs an explicit confirm", async () => {
    const c = { hubtelClientReference: "HCS-1", ledger: [led({ resolved_by: "admin9" })] }
    const m = manualSetup(commissionOrder("hubtel_bill_orders", {}, c))
    await expect(executeManualRefund(m.deps, input)).rejects.toMatchObject({ code: "NOT_ELIGIBLE", detail: { code: "CONFIRM_REQUIRED" } })
    expect(m.calls).toEqual([])
    const ok = await executeManualRefund(m.deps, { ...input, confirmOverride: true })
    expect(ok.alreadyRefunded).toBe(false)
    expect(m.state.clawbacks).toBe(1)
  })

  it("resuming a reserved manual refund also notifies", async () => {
    const m = manualSetup(commissionOrder("hubtel_bill_orders"))
    m.state.refunds.push({ id: "rf9", gateway: "manual", status: "reserved" })
    m.setOrder(commissionOrder("hubtel_bill_orders", { orderStatus: "refunding", evidence: { ...commissionOrder("hubtel_bill_orders").evidence, hasActiveRefund: true } }))
    await executeManualRefund(m.deps, input)
    expect(m.deps.notify).toHaveBeenCalledTimes(1)
  })

  it("airtime: recorded in order_refunds (gateway manual) with total_paid", async () => {
    const m = manualSetup(commissionOrder("airtime_orders", { paid: 10.13 }, { status: "failed", paymentStatus: "completed" }))
    await executeManualRefund(m.deps, { ...input, table: "airtime_orders" })
    expect(m.calls[0].args).toMatchObject({ p_order_table: "airtime_orders", p_gateway: "manual", p_paid: 10.13, p_amount: 10.13 })
  })
})

describe("refund SMS for storefront commission orders", () => {
  const db = { from: () => ({ insert: async () => ({ error: null }) }) } as any
  it("is skipped when no payer number is recorded (never sent to the beneficiary)", async () => {
    sendSMS.mockClear()
    const o = commissionOrder("airtime_orders", { recipientPhone: "0249999999", payment: { gateway: "paystack", reference: "R", payerPhone: null, walletUserId: null } })
    await notifyRefund(db, { refundId: "rf1", order: o, amount: 10, gateway: "paystack", clawbacks: [] })
    expect(sendSMS).not.toHaveBeenCalled()
  })
  it("goes to the recorded payer", async () => {
    sendSMS.mockClear()
    await notifyRefund(db, { refundId: "rf1", order: commissionOrder("hubtel_data_orders"), amount: 10, gateway: "paystack", clawbacks: [] })
    expect(sendSMS).toHaveBeenCalledWith(expect.objectContaining({ phone: "0241112222" }))
  })
})
