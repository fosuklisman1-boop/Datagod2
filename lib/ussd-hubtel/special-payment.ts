// lib/ussd-hubtel/special-payment.ts
// A Special Bundle bought on the Hubtel USSD is N unpaid child rows and ONE Hubtel payment (the transaction points at
// child 1, expected_amount = the total). This decides for the whole group, confirms each child through the shared
// engine with its dispatch replaced by a queue, and sends the queued children after the handler has returned.
import type { SupabaseClient } from "@supabase/supabase-js"
import { isPaidOutcome, type ConfirmPayment, type ConfirmResult } from "@/lib/storefront-commission/confirm"
import type { StorefrontOrderTable } from "@/lib/storefront-commission/payment"
import { safeDbError } from "./log-safe"
import type { recordBotPaymentForReview } from "./order-handlers"
import type { SpecialGroup, SpecialGroupChild } from "./special-group"

const TABLE = "hubtel_data_orders"
const LOG = "[HUBTEL-SPECIAL]"
const REFUNDS_PLACE = "Admin > Refunds"
const BUNDLES_PLACE = "Admin > Hubtel Commission > Standard Bundles"

const pesewas = (n: number) => Math.round(n * 100)

/** confirmBotPaymentQueued (lib/storefront-commission/confirm-runtime.ts); injectable for tests. */
export type ConfirmQueuedFn = (table: StorefrontOrderTable, orderId: string, p: ConfirmPayment, queue: string[]) => Promise<ConfirmResult>
/** dispatchSpecialGroup on the bundle runtime; injectable for tests. `n` = the group's size, `startedAt` = the request's start. */
export type DispatchGroupFn = (groupId: string, ids: string[], n: number, startedAt: number) => Promise<void>

export interface SpecialPaymentFacts {
  /** The row the Hubtel transaction points at (child 1). */
  orderId: string
  reference: string
  amountAfterCharges: number | null
}

export interface SpecialPaymentOpts {
  confirmQueued: ConfirmQueuedFn
  dispatchGroup: DispatchGroupFn
  /** next/server `after` in the routes. Absent: dispatch runs inline. */
  defer?: (task: () => Promise<void>) => void
  record: typeof recordBotPaymentForReview
  /** Epoch ms the request started: the dispatch budget counts everything before it too. */
  startedAt: number
}

/** Urgent admin alert (SMS with the email fallback, as the bundle runtime's urgent alerts). Never throws. */
export async function urgentAlert(message: string): Promise<void> {
  try {
    const { notifyAdmins } = await import("@/lib/sms-service")
    await notifyAdmins(message, "bills_review", undefined, false)
  } catch (e) {
    console.error(LOG, "urgent alert failed:", safeDbError(e))
  }
}

const unitOf = (c: SpecialGroupChild, n: number) => `${c.special_index}/${n}`

/**
 * Why this payment cannot be applied to the group, or null when it can. Fixed text with ids, statuses and amounts only.
 * A child already paid with THIS reference is a retry, so the engine's outcome decides it.
 */
function holdReason(group: SpecialGroup, facts: SpecialPaymentFacts): string | null {
  const n = group.children.length
  if (n < 1) return "Special group has no units"
  if (facts.amountAfterCharges == null) return "no Hubtel amount recorded for the payment"
  let total = 0
  for (const c of group.children) {
    const unit = unitOf(c, n)
    const paid = c.paid_amount == null ? NaN : Number(c.paid_amount)
    if (!Number.isFinite(paid) || paid <= 0) return `unit ${unit} has no valid paid_amount (${String(c.paid_amount)})`
    if (c.channel !== "bots") return `unit ${unit} has channel '${String(c.channel)}', not a bot order`
    const open = c.status === "pending" && c.payment_status === "unpaid"
    const retry = c.payment_status === "paid" && c.payment_reference === facts.reference
    if (!open && !retry) return `unit ${unit} is ${String(c.status)}/${String(c.payment_status)}, not payable with this payment`
    total += pesewas(paid)
  }
  if (total !== pesewas(facts.amountAfterCharges)) {
    return `Hubtel amount GHS ${facts.amountAfterCharges.toFixed(2)} does not match the group total GHS ${(total / 100).toFixed(2)}`
  }
  return null
}

/**
 * Post-payment for a Special group. All-or-nothing first: on any holdReason nothing goes through the engine and nothing
 * is sent; every child still unpaid is recorded paid + failed "needs review" (refundable), admins are alerted and this
 * throws (=> the tx row lands in needs_review).
 * Otherwise each child is confirmed in special_index order with its OWN price and the one reference: share once per
 * child, resume after a crash, no second send on a replay. Confirmation only queues ids: the sends run through
 * opts.defer, after the handler has returned (Hubtel gets its answer without waiting for N sends). A child that could
 * not be confirmed never stops the rest: what the engine queued is still sent, the failed units are recorded and named
 * in an URGENT alert, and this throws.
 */
export async function specialGroupPostPayment(
  supabase: SupabaseClient,
  group: SpecialGroup,
  facts: SpecialPaymentFacts,
  opts: SpecialPaymentOpts,
): Promise<void> {
  const { groupId, children } = group
  const record = async (reason: string) => {
    try {
      await opts.record(supabase, TABLE, facts.orderId, { reference: facts.reference, reason })
    } catch (e) {
      console.error(LOG, "could not record the held payment on the group:", groupId, safeDbError(e))
    }
  }

  const reason = holdReason(group, facts)
  if (reason) {
    await record(reason)
    await urgentAlert(`URGENT: Special group ${groupId}: Hubtel payment (ref ${facts.reference}) held for review: ${reason}. Nothing was sent; refund or deliver it from ${REFUNDS_PLACE}.`)
    throw new Error(`${TABLE} ${facts.orderId}: Special group ${groupId}: ${reason}: needs manual review`)
  }

  const n = children.length
  const queue: string[] = []
  const failed: string[] = []
  for (const c of children) {
    let r: ConfirmResult
    try {
      r = await opts.confirmQueued(TABLE, c.id, { paidAmount: Number(c.paid_amount), reference: facts.reference }, queue)
    } catch (e) {
      console.error(LOG, "child confirmation threw:", groupId, c.id, safeDbError(e))
      r = { outcome: "error" }
    }
    // 'confirmed' on a row no longer pending: failed between our read and the flip, so it is paid and will not be sent.
    const flippedNotPending = r.outcome === "confirmed" && r.status !== undefined && r.status !== "pending"
    if (!isPaidOutcome(r.outcome) || flippedNotPending) failed.push(`${unitOf(c, n)} (${c.id}, ${flippedNotPending ? `status ${r.status}` : r.outcome})`)
  }

  // Only units the engine did not flip are still unpaid here, so this records exactly the failed ones (guarded no-op otherwise).
  const failedText = failed.join(", ")
  if (failed.length > 0) await record(`bot payment confirmation failed for unit ${failedText}`)

  if (queue.length > 0) {
    const task = async () => {
      try {
        await opts.dispatchGroup(groupId, queue, n, opts.startedAt)
      } catch (e) {
        console.error(LOG, "group dispatch failed:", groupId, safeDbError(e))
        await urgentAlert(`URGENT: Special group ${groupId}: PAID but dispatch failed (${queue.length} of ${n} units may be unsent). Send them from ${BUNDLES_PLACE}.`)
      }
    }
    if (opts.defer) {
      try {
        opts.defer(task)
      } catch (e) {
        // The payment is taken: sending late in this request beats not sending.
        console.error(LOG, "group dispatch could not be deferred; running inline:", groupId, safeDbError(e))
        await task()
      }
    } else {
      await task()
    }
  }

  if (failed.length > 0) {
    await urgentAlert(`URGENT: Special group ${groupId}: Hubtel payment (ref ${facts.reference}) taken but unit ${failedText} could not be confirmed. Those units were not sent; refund or deliver them from ${REFUNDS_PLACE}.`)
    throw new Error(`${TABLE} ${facts.orderId}: Special group ${groupId}: unit ${failedText} not confirmed: needs manual review`)
  }
}
