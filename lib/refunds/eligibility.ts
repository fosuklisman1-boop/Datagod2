import { refundDecision, UNSENT_GRACE_MS } from "@/lib/bills/admin"
import { isBeforeStorefrontRefunds, isCommissionTable, STOREFRONT_REFUNDS_FROM, type CommissionEvidence, type CommissionTable, type DispatchOutcome, type OrderTable, type RefundableOrder } from "./types"

export interface EligibilityInput {
  /** Omitted = one of the original tables (pending only). */
  table?: OrderTable
  orderStatus: string
  paymentStatus: string
  hasActiveRefund: boolean
  dispatchOutcome: DispatchOutcome | null
  trackingStatuses: string[]
  externalOrderId: string | null
  /** Commission tables only: the raw order facts + Hubtel ledger rows. */
  commission?: CommissionEvidence
  /** Clock (ms epoch) for the never-sent grace / stuck-claim ages. Defaults to Date.now(). */
  now?: number
}

export type EligibilityCode =
  | "NOT_PENDING" | "ALREADY_REFUNDED" | "DISPATCH_IN_PROGRESS" | "DISPATCH_UNKNOWN"
  | "PROVIDER_IN_PROGRESS" | "SENT_TO_PROVIDER" | "NOT_STOREFRONT" | "HUBTEL_BLOCKED" | "BEFORE_LAUNCH"

/**
 * releaseStuck: a stuck Hubtel dispatch claim (processing, never reached Hubtel, >= 5 min) must be released first.
 * warning: refundable, but only after the admin explicitly confirms (admin-overridden Hubtel failure).
 */
export type Eligibility =
  | { eligible: true; releaseStuck?: boolean; warning?: string }
  | { eligible: false; code: EligibilityCode; reason: string }

/** Eligibility of a loaded order (the one place the pending list, preview and execute agree on). */
export function orderEligibility(o: RefundableOrder, now: number = Date.now()): Eligibility {
  return evaluateEligibility({
    table: o.table, orderStatus: o.orderStatus, paymentStatus: o.paymentStatus, hasActiveRefund: o.evidence.hasActiveRefund,
    dispatchOutcome: o.evidence.dispatchOutcome, trackingStatuses: o.evidence.trackingStatuses,
    externalOrderId: o.evidence.externalOrderId, commission: o.evidence.commission, now,
  })
}

const LIVE_LEDGER = new Set(["created", "pending", "needs_review"])
/** Notes written by the Digiwapy send / webhook / sync paths ("Auto-fulfilled via Digiwapy [dgwRef:…]", "Digiwapy: …"). */
const DIGIWAPY_NOTE = /dgwRef:|digiwapy/i
const HCS_REF = /hcsRef:([A-Za-z0-9_-]+)/

/**
 * Storefront airtime. Airtime has its own provider lifecycle (a Hubtel failure returns the order to `pending` for manual
 * fulfilment), so the bills decision (which wants `failed`) does not fit; the same ledger rules apply.
 */
function airtimeEligibility(c: CommissionEvidence, now: number): Eligibility {
  // The loader always sets createdAt (an unparseable value fails closed); undefined = evidence built without it.
  if (c.createdAt !== undefined && isBeforeStorefrontRefunds(c.createdAt)) {
    return no("BEFORE_LAUNCH", `Placed before ${STOREFRONT_REFUNDS_FROM.slice(0, 10)}: storefront airtime from before then is refunded outside Datagod, as before`)
  }
  if (c.paymentStatus !== "completed") return no("NOT_PENDING", "This order was never paid")
  if (c.status === "completed") return no("SENT_TO_PROVIDER", "Delivered orders cannot be refunded")
  if (c.ledger.some((l) => l.state === "fulfilled")) return no("SENT_TO_PROVIDER", "Hubtel delivered this airtime; it cannot be refunded")
  const live = c.ledger.find((l) => LIVE_LEDGER.has(l.state))
  if (live) return no("PROVIDER_IN_PROGRESS", `Hubtel transaction ${live.client_reference} is ${live.state.replace("_", " ")} and may still deliver. Resolve it in Hubtel Commission first.`)
  if (c.status === "processing") return no("PROVIDER_IN_PROGRESS", "Being sent to a provider; wait for it to finish or fail")
  if (c.status !== "pending" && c.status !== "failed") return no("NOT_PENDING", `Order is ${c.status}; it cannot be refunded`)
  // A provider send was recorded (Digiwapy sends while the order is still `pending`, and a Digiwapy failure also lands
  // back on `pending`): only an admin who confirmed non-delivery (order marked failed) may refund it.
  const notes = c.notes ?? ""
  if (c.status !== "failed" && DIGIWAPY_NOTE.test(notes)) {
    return no("PROVIDER_IN_PROGRESS", "A Digiwapy send was recorded for this order. Confirm it was not delivered and mark it Failed on /admin/airtime, then refund.")
  }
  const hcsRef = notes.match(HCS_REF)?.[1]
  if (c.status !== "failed" && hcsRef && !c.ledger.some((l) => l.client_reference === hcsRef)) {
    return no("PROVIDER_IN_PROGRESS", `Hubtel reference ${hcsRef} is recorded but its ledger row was not found; check Hubtel Commission before refunding`)
  }
  if (c.status === "pending" && !(now - Date.parse(c.updatedAt) >= UNSENT_GRACE_MS)) {
    return no("DISPATCH_IN_PROGRESS", "This order was updated moments ago and may still be dispatching; try again in a minute")
  }
  return { eligible: true }
}

/**
 * Storefront bills/bundles: the bills admin-refund decision (lib/bills/admin.ts refundDecision) — it is ledger-aware
 * (failed ledger rows are refundable once the order is failed). The bundles decision instead sends every ledger row to
 * the Hubtel review queue, whose wallet refund cannot pay an anonymous storefront buyer, so it is not used here.
 */
function billOrBundleEligibility(c: CommissionEvidence, now: number): Eligibility {
  const d = refundDecision({
    status: c.status, payment_status: c.paymentStatus, hubtel_client_reference: c.hubtelClientReference,
    notes: c.notes, updated_at: c.updatedAt,
  }, c.ledger, now)
  if (d.action === "blocked") return no("HUBTEL_BLOCKED", d.reason)
  if (d.action === "direct" && d.releaseStuck) return { eligible: true, releaseStuck: true }
  if (d.action === "ledger" && d.needsForce) {
    // The review queue would demand `force` here; the admin must explicitly confirm instead.
    return { eligible: true, warning: `Hubtel transaction ${d.ref} was marked failed by an admin override, not by Hubtel. Confirm it was not delivered before refunding.` }
  }
  return { eligible: true }
}

function commissionEligibility(table: CommissionTable, i: EligibilityInput): Eligibility {
  const c = i.commission
  if (!c) return no("NOT_PENDING", "Order details could not be loaded")
  if (!c.storefront) return no("NOT_STOREFRONT", "Not a storefront order — refund it through its own refund path")
  if (i.hasActiveRefund) return no("ALREADY_REFUNDED", "A refund already exists for this order")
  const now = i.now ?? Date.now()
  return table === "airtime_orders" ? airtimeEligibility(c, now) : billOrBundleEligibility(c, now)
}

const TERMINAL_FAILED = new Set(["failed", "error", "abandoned"])
const IN_FLIGHT = new Set(["pending", "processing", "retrying"])

/** Order statuses a refund may start from. api_orders may also be held by the MTN registration gate (paid, never sent). */
export function refundableStatuses(table: OrderTable): readonly string[] {
  if (isCommissionTable(table)) return ["pending", "failed"] // mirrors reserve_order_refund (0120)
  return table === "api_orders" ? ["pending", "held_registration"] : ["pending"]
}

const no = (code: EligibilityCode, reason: string): Eligibility => ({ eligible: false, code, reason })

export function evaluateEligibility(i: EligibilityInput): Eligibility {
  if (i.table && isCommissionTable(i.table)) return commissionEligibility(i.table, i)
  if (!refundableStatuses(i.table ?? "shop_orders").includes(i.orderStatus) || i.paymentStatus !== "completed") return no("NOT_PENDING", "Order is not a paid, pending order")
  if (i.hasActiveRefund) return no("ALREADY_REFUNDED", "A refund already exists for this order")
  if (i.dispatchOutcome === "claimed") return no("DISPATCH_IN_PROGRESS", "Being sent to a provider right now")
  if (i.dispatchOutcome === "unknown") return no("DISPATCH_UNKNOWN", "A provider call ended with an unknown result — investigate before refunding")

  const live = i.trackingStatuses.filter((s) => !TERMINAL_FAILED.has(s))
  if (live.some((s) => IN_FLIGHT.has(s))) return no("PROVIDER_IN_PROGRESS", "Provider order is still in progress")
  if (live.length > 0) return no("SENT_TO_PROVIDER", "Provider reports the order was delivered/accepted")

  const hasTracking = i.trackingStatuses.length > 0
  if (!hasTracking && (i.dispatchOutcome === "submitted" || i.externalOrderId)) {
    return no("SENT_TO_PROVIDER", "Sent to a provider and failure cannot be confirmed")
  }
  return { eligible: true }
}
