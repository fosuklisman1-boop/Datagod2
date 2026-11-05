// lib/hubtel-pay/lookup.ts
// The one question every Paystack-era verifier asks before touching a payment: "is this a Hubtel payment?"
//
// A Hubtel payment is a wallet_payments row with payment_method 'hubtel', and/or a hubtel_payments row whose
// internal_reference is the caller's reference (the WALLET-… reference, or the order id for USSD-style orders).
// Paystack never saw those references, so a Paystack verify answers 404 for them, which the verifiers read as
// "abandoned". Verifiers skip such rows, or confirm them through Hubtel.
import type { SupabaseClient } from "@supabase/supabase-js"
import type { ConfirmOutcome, HubtelPaymentStatus } from "./confirm"

export interface HubtelPaymentRef {
  /** Opaque reference: the only one Hubtel knows, and what confirmHubtelPayment takes. */
  reference: string
  internal_reference: string
  status: HubtelPaymentStatus
  amount_pesewas: number
  created_at: string
}

/** A row in one of these may hold or still receive the customer's money: Paystack must not close its order. */
export const LIVE_HUBTEL_STATUSES: readonly HubtelPaymentStatus[] = ["pending", "confirming", "paid", "needs_review"]

export const isLiveHubtelStatus = (status: string | null | undefined): boolean =>
  !!status && (LIVE_HUBTEL_STATUSES as readonly string[]).includes(status)

/** wallet_payments row is Hubtel's: its own method says so, or a live Hubtel attempt exists for its reference. */
export function isHubtelWalletPayment(
  payment: { payment_method?: string | null },
  hubtelRow: Pick<HubtelPaymentRef, "status"> | null | undefined,
): boolean {
  return payment.payment_method === "hubtel" || isLiveHubtelStatus(hubtelRow?.status)
}

/** How the verifier routes report a Hubtel row, in their Paystack-shaped `status` fields. */
export function hubtelReportStatus(status: HubtelPaymentStatus): "success" | "failed" | "pending" | "needs_review" {
  if (status === "paid") return "success"
  if (status === "failed") return "failed"
  if (status === "needs_review") return "needs_review"
  return "pending"
}

const COLUMNS = "reference, internal_reference, status, amount_pesewas, created_at"
const CHUNK = 200
/** Higher wins when one internal reference has several attempts: money first, then open, then closed. */
const RANK: Record<string, number> = { paid: 4, needs_review: 3, confirming: 2, pending: 2, failed: 1 }

/** The table does not exist yet (migration 0151 unapplied): no Hubtel payment can exist. */
const isMissingTable = (e: { code?: string } | null | undefined) => e?.code === "42P01" || e?.code === "PGRST205"

/**
 * The most relevant Hubtel attempt per internal reference (paid > needs_review > open > failed, newest first).
 * One query per 200 references. Throws on a database error other than a missing table: a caller that cannot tell
 * must not treat the payment as Paystack's.
 */
export async function findHubtelPayments(
  sb: SupabaseClient,
  internalRefs: readonly (string | null | undefined)[],
): Promise<Map<string, HubtelPaymentRef>> {
  const refs = [...new Set(internalRefs.filter((r): r is string => typeof r === "string" && r.length > 0))]
  const out = new Map<string, HubtelPaymentRef>()
  for (let i = 0; i < refs.length; i += CHUNK) {
    const { data, error } = await sb.from("hubtel_payments").select(COLUMNS).in("internal_reference", refs.slice(i, i + CHUNK))
    if (error) {
      if (isMissingTable(error)) return new Map()
      throw new Error(`hubtel_payments lookup failed: ${error.code ?? error.message ?? "unknown"}`)
    }
    for (const r of (data ?? []) as HubtelPaymentRef[]) {
      const cur = out.get(r.internal_reference)
      if (!cur || better(r, cur)) out.set(r.internal_reference, r)
    }
  }
  return out
}

function better(a: HubtelPaymentRef, b: HubtelPaymentRef): boolean {
  const ra = RANK[a.status] ?? 0
  const rb = RANK[b.status] ?? 0
  if (ra !== rb) return ra > rb
  return new Date(a.created_at).getTime() > new Date(b.created_at).getTime()
}

/** One hubtel_payments attempt with the facts a refund needs. */
export interface HubtelAttemptRow extends HubtelPaymentRef {
  /** What the shared charge handlers were told was paid, when it differs from amount_pesewas (the merchant bears the fee). */
  handler_amount_pesewas: number | null
  msisdn: string | null
  channel: string | null
  payment_method: string | null
}

const ATTEMPT_COLUMNS = `${COLUMNS}, handler_amount_pesewas, msisdn, channel, payment_method`

/**
 * EVERY attempt per internal reference (not just the best one), newest first, for refund decisions that must see
 * all of an order's attempts: whether any is unsettled, and how many were paid. Same chunking and failure rules as
 * findHubtelPayments (a missing table means none; any other database error throws).
 */
export async function findHubtelAttempts(
  sb: SupabaseClient,
  internalRefs: readonly (string | null | undefined)[],
): Promise<Map<string, HubtelAttemptRow[]>> {
  const refs = [...new Set(internalRefs.filter((r): r is string => typeof r === "string" && r.length > 0))]
  const out = new Map<string, HubtelAttemptRow[]>()
  for (let i = 0; i < refs.length; i += CHUNK) {
    const { data, error } = await sb.from("hubtel_payments").select(ATTEMPT_COLUMNS).in("internal_reference", refs.slice(i, i + CHUNK))
    if (error) {
      if (isMissingTable(error)) return new Map()
      throw new Error(`hubtel_payments lookup failed: ${error.code ?? error.message ?? "unknown"}`)
    }
    for (const r of (data ?? []) as HubtelAttemptRow[]) {
      const list = out.get(r.internal_reference) ?? []
      list.push(r)
      out.set(r.internal_reference, list)
    }
  }
  for (const list of out.values()) list.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
  return out
}

/** Single-reference form of findHubtelPayments. */
export async function findHubtelPaymentByInternalRef(sb: SupabaseClient, internalRef: string): Promise<HubtelPaymentRef | null> {
  return (await findHubtelPayments(sb, [internalRef])).get(internalRef) ?? null
}

type Confirm = (reference: string) => Promise<ConfirmOutcome>

/**
 * Ask Hubtel (through confirmHubtelPayment, which decides and fulfils exactly once), then re-read the row so the
 * caller reports what the row now says. A throwing confirm is reported as check_error with the last known status.
 */
export async function confirmAndReadHubtelPayment(
  sb: SupabaseClient,
  row: HubtelPaymentRef,
  confirm?: Confirm,
): Promise<{ reference: string; outcome: ConfirmOutcome; status: HubtelPaymentStatus; amount_pesewas: number }> {
  const run: Confirm = confirm ?? (async (r) => (await import("./confirm")).confirmHubtelPayment(r))
  let outcome: ConfirmOutcome
  try {
    outcome = await run(row.reference)
  } catch (e) {
    console.error("[hubtel-pay] confirm from a verifier failed", row.reference, e instanceof Error ? e.message : "unknown error")
    outcome = "check_error"
  }
  let status = row.status
  try {
    const { data, error } = await sb.from("hubtel_payments").select("status").eq("reference", row.reference).maybeSingle()
    if (!error && data && typeof (data as { status?: unknown }).status === "string") status = (data as { status: HubtelPaymentStatus }).status
  } catch { /* keep the last known status */ }
  return { reference: row.reference, outcome, status, amount_pesewas: row.amount_pesewas }
}
