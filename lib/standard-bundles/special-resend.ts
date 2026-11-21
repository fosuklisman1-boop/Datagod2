import type { DataOrderRow } from "./service"

/**
 * Special Bundles admin resend (2026-11-20). Hubtel can report every unit of a group delivered (separate MTN ids) while
 * the handset shows fewer. A completed unit cannot be sent again on its own row (hubtel_cs_tx_order_active_uidx allows
 * a new Hubtel transaction only once every earlier one failed), so a resend is ONE new replacement order:
 * - reference `SBR-<original id hex>`: UNIQUE reference_code => at most one replacement per unit, race-proof;
 * - paid, but not charged (paid_amount NULL; it re-buys the unit from the Hubtel float, the customer pays nothing more);
 * - outside the group (no special_group_id), no shop link, no cashback / share fields: nothing is credited on it;
 * - never refundable (isSpecialReplacement guards every refund path); Retry stays available if Hubtel fails it.
 */

export const REPLACEMENT_PREFIX = "SBR-"

/** Shown wherever a refund of a unit that was already resent is refused (the customer got the replacement). */
export const RESENT_NOT_REFUNDABLE = "This Special unit was already resent by an admin (an SBR- replacement exists); it cannot also be refunded."

/** Shown wherever a refund of a replacement is refused. */
export const REPLACEMENT_NOT_REFUNDABLE = "This is an admin replacement for a Special unit (the customer was not charged for it); it cannot be refunded. Use Retry if Hubtel failed it."

/** The fixed replacement reference of a unit: SBR- + its id's 32 hex digits, uppercase. */
export const replacementRef = (orderId: string): string => REPLACEMENT_PREFIX + orderId.replace(/-/g, "").toUpperCase()

/** An admin replacement order (never refundable). Normal references are SB- + hex, which never contains "R". */
export const isSpecialReplacement = (referenceCode: string | null | undefined): boolean =>
  typeof referenceCode === "string" && referenceCode.startsWith(REPLACEMENT_PREFIX)

export interface ResendSource {
  id: string; reference_code: string; user_id: string | null; channel: string; network: string; service_key: string
  beneficiary_phone: string; bundle_value: string; bundle_display: string; bundle_category: string
  amount: number; paid_amount?: number | null; status: string; payment_status: string
  special_group_id?: string | null; special_index?: number | null
  bot_surface?: string | null; buyer_phone?: string | null; buyer_name?: string | null; buyer_email?: string | null
  shop_id?: string | null; cashback_amount?: number | null; shop_share_amount?: number | null
}

/** A completed, paid unit of a Special group that is not itself a replacement. */
export const canResend = (o: Pick<ResendSource, "status" | "payment_status" | "special_group_id" | "special_index" | "reference_code">): boolean =>
  o.status === "completed" && o.payment_status === "paid" && !!o.special_group_id && !!o.special_index && !isSpecialReplacement(o.reference_code)

export type ReplacementRow = ReturnType<typeof buildReplacementRow>

export function buildReplacementRow(o: ResendSource, adminId: string, now: number) {
  return {
    reference_code: replacementRef(o.id),
    idempotency_key: `resend:${o.id}`,
    user_id: o.user_id, channel: o.channel, network: o.network, service_key: o.service_key,
    beneficiary_phone: o.beneficiary_phone, bundle_value: o.bundle_value, bundle_display: o.bundle_display, bundle_category: o.bundle_category,
    amount: o.amount, status: "pending" as const, payment_status: "paid" as const, paid_at: new Date(now).toISOString(),
    bot_surface: o.bot_surface ?? null, buyer_phone: o.buyer_phone ?? null, buyer_name: o.buyer_name ?? null, buyer_email: o.buyer_email ?? null,
    notes: `Replacement for Special unit ${o.special_index} (order ${o.reference_code}), resent by admin ${adminId}. Not charged; not refundable.`,
  }
}

export interface SpecialResendDeps {
  getOrder(id: string): Promise<ResendSource | null>
  /** The order holding this reference_code, if any. Throws on read error. */
  findByReference(referenceCode: string): Promise<{ id: string; status: string } | null>
  /** Insert; `duplicate` when the unique reference (or idempotency key) already exists. Throws on any other error. */
  insertReplacement(row: ReplacementRow): Promise<{ ok: true; order: DataOrderRow } | { ok: false; duplicate: true }>
  /** dispatchBundleOrder on the bundle runtime (atomic pending -> processing claim); the resulting status. */
  dispatch(order: DataOrderRow): Promise<string>
  now(): number
}

export interface SpecialResendResult { ok: boolean; status: number; message: string; orderStatus?: string; replacementId?: string }

export async function executeSpecialResend(d: SpecialResendDeps, orderId: string, adminId: string): Promise<SpecialResendResult> {
  const o = await d.getOrder(orderId)
  if (!o) return { ok: false, status: 404, message: "Order not found" }
  if (!canResend(o)) return { ok: false, status: 409, message: "Only a completed Special unit (not a replacement) can be resent" }

  const ref = replacementRef(o.id)
  let existing: { id: string; status: string } | null
  try { existing = await d.findByReference(ref) } catch { return { ok: false, status: 503, message: "Could not check for an earlier resend; try again" } }
  if (existing) return { ok: false, status: 409, message: `This unit was already resent once (${ref}, ${existing.status}). Use Retry or Dispatch on that order instead.` }

  const ins = await d.insertReplacement(buildReplacementRow(o, adminId, d.now()))
  if (!ins.ok) return { ok: false, status: 409, message: `This unit was already resent once (${ref}). Reload the page.` }

  const status = await d.dispatch(ins.order)
  const base = { status: 200, orderStatus: status, replacementId: ins.order.id }
  if (status === "processing" || status === "completed") return { ok: true, ...base, message: `Resent as ${ref}; it is ${status}` }
  if (status === "pending") return { ok: false, ...base, message: `Replacement ${ref} was created but not sent; use Dispatch on it` }
  return { ok: false, ...base, message: `Hubtel did not accept replacement ${ref} (${status}); use Retry on it` }
}
