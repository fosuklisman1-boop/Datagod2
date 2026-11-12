import { airtimeNetId } from "./airtime-provider"
import type { PurchaseInput } from "./hubtel-cs/client"
import {
  HubtelDuplicateOrderError, HubtelOutcomeUnknownError,
} from "./hubtel-cs/errors"
import type { HubtelCsServiceKey } from "./hubtel-cs/services"
import type { HubtelCsTx } from "./hubtel-cs/types"

export interface AirtimeOrderMinimal {
  id: string
  reference_code: string
  network: string
  beneficiary_phone: string
  airtime_amount: number
}

/** Hubtel's per-request airtime cap (docs: "maximum airtime top-up amount per request is 100 cedis"). */
export const HUBTEL_AIRTIME_MAX = 100

export interface AirtimeHubtelDeps {
  purchase(input: PurchaseInput): Promise<HubtelCsTx>
  /** When onlyFromStatuses is given the write MUST only apply to an order currently in one of those statuses. */
  markOrder(orderId: string, patch: { status?: string; notes: string }, onlyFromStatuses?: string[]): Promise<number | void>
  /** kind "review" = Hubtel outcome unknown / in review; "manual" (default) = not sent, fulfil manually. */
  alert(message: string, kind?: "manual" | "review"): Promise<void>
  /** Re-read the ledger row (null if missing). Used to catch a terminal callback that raced the processing write. */
  refreshTx(clientReference: string): Promise<HubtelCsTx | null>
  /** Re-apply a terminal ledger row to the order (the idempotent order hook). */
  settle(tx: HubtelCsTx): Promise<void>
}

const quiet = async (p: Promise<unknown>, what: string) => {
  try { await p } catch (e: any) { console.error(`[AIRTIME-HUBTEL] ${what} failed:`, e?.message ?? e) }
}

/**
 * Hand a paid airtime order to Hubtel. Returns true when Hubtel owns it now (pending, settled, outcome
 * unknown, or a live Hubtel transaction already exists) and false when nothing was sent (manual needed).
 * Never resends, never falls back to another provider, never throws.
 */
export async function fulfillAirtimeViaHubtel(order: AirtimeOrderMinimal, deps: AirtimeHubtelDeps): Promise<boolean> {
  const tag = `${order.reference_code} (${order.network} ${order.beneficiary_phone} GHS ${order.airtime_amount})`
  const notSent = async (why: string) => {
    await quiet(deps.markOrder(order.id, { notes: `Hubtel: not sent - ${why}. Fulfil manually.` }), "markOrder")
    await quiet(deps.alert(`Airtime ${tag} needs manual fulfilment: Hubtel not sent - ${why}`), "alert")
    return false
  }

  const id = airtimeNetId(order.network)
  if (!id) return notSent(`unsupported network "${order.network}"`)
  if (!(order.airtime_amount <= HUBTEL_AIRTIME_MAX)) return notSent(`amount over the Hubtel limit of GHS ${HUBTEL_AIRTIME_MAX}`)

  try {
    const tx = await deps.purchase({
      serviceKey: `airtime_${id}` as HubtelCsServiceKey,
      destination: order.beneficiary_phone,
      amount: order.airtime_amount,
      orderTable: "airtime_orders",
      orderId: order.id,
    })
    if (tx.state === "needs_review") {
      await quiet(deps.markOrder(order.id, { status: "processing", notes: `Hubtel: outcome unknown, in review [hcsRef:${tx.client_reference}]. Do not resend.` }, ["pending"]), "markOrder")
      await quiet(deps.alert(`Airtime ${tag}: Hubtel outcome unknown (ref ${tx.client_reference}) - check the Hubtel review queue, do not resend`, "review"), "alert")
      return true
    }
    if (tx.state === "pending" || tx.state === "created") {
      let markFailed = false
      try {
        const rows = await deps.markOrder(order.id, { status: "processing", notes: `Sent via Hubtel [hcsRef:${tx.client_reference}]` }, ["pending"])
        if (rows === 0) markFailed = true
      } catch (e: any) {
        console.error("[AIRTIME-HUBTEL] markOrder failed:", e?.message ?? e)
        markFailed = true
      }
      // A fast terminal callback may have been applied before the processing write above (which would then
      // have overwritten it); re-apply it. The adapter only writes from pending/processing, so this is safe.
      let settledTerminal = false
      try {
        const fresh = await deps.refreshTx(tx.client_reference)
        if (fresh && (fresh.state === "fulfilled" || fresh.state === "failed")) { settledTerminal = true; await deps.settle(fresh) }
      } catch (e: any) { console.error("[AIRTIME-HUBTEL] post-write settle check failed:", e?.message ?? e) }
      // 0 rows because a terminal callback already settled the order is expected; otherwise the order is not marked.
      if (markFailed && !settledTerminal) {
        await quiet(deps.alert(`Airtime ${tag}: Hubtel has order ${order.id} (ref ${tx.client_reference}) but the order could not be marked processing - do NOT resend`, "review"), "alert")
      }
    }
    // fulfilled / failed were already applied to the order by the adapter hook.
    return tx.state !== "failed"
  } catch (e: any) {
    if (e instanceof HubtelDuplicateOrderError) return true
    if (e instanceof HubtelOutcomeUnknownError) {
      await quiet(deps.markOrder(order.id, { status: "processing", notes: `Hubtel: outcome unknown [hcsRef:${e.clientReference}]. Do not resend.` }, ["pending"]), "markOrder")
      await quiet(deps.alert(`Airtime ${tag}: Hubtel POST may have been sent (ref ${e.clientReference}) - check the Hubtel review queue, do not resend`, "review"), "alert")
      return true
    }
    // Every other error is raised before the POST (disabled, paused, not configured, validation, insert failure).
    return notSent(e?.message ?? "error")
  }
}

export interface AirtimeRetryOrder extends AirtimeOrderMinimal {
  status: string
  payment_status: string
  notes: string | null
}

export interface AirtimeRetryDeps {
  getOrder(orderId: string): Promise<AirtimeRetryOrder | null>
  /** Status-guarded write; MUST apply only while the order is in one of onlyFromStatuses. Returns rows changed. */
  markOrder(orderId: string, patch: { status?: string; notes: string }, onlyFromStatuses: string[]): Promise<number>
  purchase(input: PurchaseInput): Promise<HubtelCsTx>
  refreshTx(clientReference: string): Promise<HubtelCsTx | null>
  /** Re-apply a terminal ledger row to the order (the idempotent order hook). */
  settle(tx: HubtelCsTx): Promise<void>
  alert(message: string, kind?: "manual" | "review"): Promise<void>
}

export interface AirtimeRetryResult { ok: boolean; status: number; message: string; orderStatus?: string }

/**
 * Admin re-send of a paid airtime order whose last Hubtel attempt (`failedRef`) failed. The caller has already
 * checked the ledger (lib/hubtel-cs/retry.ts ledgerRetryCheck). Unlike first-time fulfilment, the order is claimed
 * (pending -> processing) BEFORE the POST, so a concurrent /admin/refunds refund or manual fulfilment loses the race
 * instead of running alongside a new Hubtel send. Never throws.
 */
export async function retryAirtimeViaHubtel(d: AirtimeRetryDeps, orderId: string, failedRef: string): Promise<AirtimeRetryResult> {
  const refuse = (message: string): AirtimeRetryResult => ({ ok: false, status: 409, message })
  let order: AirtimeRetryOrder | null
  try { order = await d.getOrder(orderId) } catch { return { ok: false, status: 503, message: "Could not read the airtime order; try again" } }
  if (!order) return { ok: false, status: 404, message: "Order not found" }
  if (order.payment_status !== "completed") return refuse("This airtime order was never paid")
  if (order.status !== "pending") return refuse(`Only airtime orders returned to pending by a Hubtel failure can be retried; this one is ${order.status}`)
  // onFailed leaves "[hcsRef:<failed ref>]" in the notes. Anything else means an admin or another provider has
  // touched the order since (e.g. a manual Digiwapy send): do not send a second value on top of that.
  if (!(order.notes ?? "").includes(`hcsRef:${failedRef}`)) return refuse("This order was handled since that Hubtel failure (see its notes); retry it from Airtime orders instead")
  const id = airtimeNetId(order.network)
  if (!id) return refuse(`Unsupported network "${order.network}"`)
  if (!(order.airtime_amount <= HUBTEL_AIRTIME_MAX)) return refuse(`Amount is over the Hubtel limit of GHS ${HUBTEL_AIRTIME_MAX}`)

  const originalNotes = order.notes ?? ""
  let claimed = 0
  try {
    claimed = await d.markOrder(orderId, { status: "processing", notes: `Retrying via Hubtel after failure [prevRef:${failedRef}]` }, ["pending"])
  } catch { claimed = 0 }
  if (claimed === 0) return refuse("The order changed; reload and try again")

  const tag = `${order.reference_code} (${order.network} ${order.beneficiary_phone} GHS ${order.airtime_amount})`
  const stamp = (notes: string) => d.markOrder(orderId, { notes }, ["processing"]).catch(() => 0)
  let tx: HubtelCsTx
  try {
    tx = await d.purchase({
      serviceKey: `airtime_${id}` as HubtelCsServiceKey,
      destination: order.beneficiary_phone,
      amount: order.airtime_amount,
      orderTable: "airtime_orders",
      orderId,
    })
  } catch (e: any) {
    if (e instanceof HubtelDuplicateOrderError) {
      await quiet(d.alert(`Airtime ${tag}: retry refused, a live Hubtel transaction already exists. The order is left processing - reconcile it by hand on /admin/airtime once that transaction settles; do not resend`, "review"), "alert")
      return refuse("A live Hubtel transaction already exists for this order; check the review queue")
    }
    if (e instanceof HubtelOutcomeUnknownError) {
      await stamp(`Hubtel retry: outcome unknown [hcsRef:${e.clientReference}]. Do not resend.`)
      await quiet(d.alert(`Airtime ${tag}: Hubtel retry outcome unknown (ref ${e.clientReference}) - check the review queue, do not resend`, "review"), "alert")
      return { ok: true, status: 200, orderStatus: "processing", message: "Retry sent but the outcome is unknown; it is in the review queue" }
    }
    // Raised before the POST: nothing reached Hubtel. Restore the order exactly so it can be retried again.
    const why = e?.message ?? "error"
    const back = await d.markOrder(orderId, { status: "pending", notes: `Retry not sent: ${why}. ${originalNotes}` }, ["processing"]).catch(() => 0)
    if (back === 0) await quiet(d.alert(`Airtime ${tag}: a Hubtel retry was not sent and the order could not be put back to pending. Check it by hand.`), "alert")
    return { ok: false, status: 200, orderStatus: back === 0 ? "processing" : "pending", message: `Retry not sent: ${why}` }
  }

  const reconcile = (why: string) => quiet(d.alert(
    `Airtime ${tag}: Hubtel retry ref ${tx.client_reference} was sent but ${why}. The order may stay processing - reconcile it by hand on /admin/airtime; do not resend`, "review"), "alert")
  const stamped = await stamp(tx.state === "needs_review"
    ? `Hubtel retry: outcome unknown, in review [hcsRef:${tx.client_reference}]. Do not resend.`
    : `Sent via Hubtel (admin retry) [hcsRef:${tx.client_reference}]`)
  // Without the new hcsRef in its notes the airtime adapter will not fail this order later: never leave that silent.
  if (stamped === 0) await reconcile("its reference could not be written to the order")
  if (tx.state === "needs_review") {
    await quiet(d.alert(`Airtime ${tag}: Hubtel retry outcome unknown (ref ${tx.client_reference}) - check the review queue, do not resend`, "review"), "alert")
  }
  // The order hook may have run while the order still carried the claim note (the airtime adapter only fails an
  // order whose notes name the attempt), so re-apply the latest ledger state now that the new ref is stamped.
  let latest: HubtelCsTx = tx
  try {
    const fresh = await d.refreshTx(tx.client_reference)
    if (fresh) latest = fresh
    if (latest.state === "fulfilled" || latest.state === "failed") await d.settle(latest)
  } catch (e: any) {
    console.error("[AIRTIME-HUBTEL] retry settle failed:", e?.message ?? e)
    await reconcile("its result could not be re-applied to the order")
  }

  if (latest.state === "failed") {
    return { ok: false, status: 200, orderStatus: "pending", message: `Hubtel failed again: ${latest.failure_reason ?? latest.response_code ?? "unknown reason"}` }
  }
  if (latest.state === "fulfilled") return { ok: true, status: 200, orderStatus: "completed", message: "Retried and delivered" }
  if (latest.state === "needs_review") return { ok: true, status: 200, orderStatus: "processing", message: "Retry sent; outcome unknown, it is in the review queue" }
  return { ok: true, status: 200, orderStatus: "processing", message: "Retry sent; waiting for Hubtel's callback" }
}
