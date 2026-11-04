// lib/hubtel-pay/confirm.ts
// Decides whether one Hubtel payment is paid and fulfils it exactly once.
//
// Never trusts a callback: the decision comes from the relay status check. Before ANY final transition (paid,
// failed, needs_review) the row is claimed with ONE conditional update (RPC claim_hubtel_payment, migration 0152):
// pending -> confirming, or a confirming claim older than 10 minutes. Only the caller that gets the row back
// continues, so a callback and the sweep arriving together cause at most one handler call and one alert.
// Every write after the claim is guarded on status='confirming' AND our claimed_at.
//
// A `failed` row younger than 72h is still status-checked: Hubtel can report Paid after we gave up. That row is never
// fulfilled (the failure handler has already run); it goes failed -> needs_review with one alert, guarded on
// status='failed' so concurrent callers cannot alert twice.
import type { ChargeEventData } from "@/lib/payments/charge-events"
import { checkPaymentStatus, type PaymentStatus } from "./client"

/**
 * check_error: nothing was decided because of a fault rather than normal waiting: the status check came back kind
 * `error`, or a needs_review write did not land. The row is left as it was. Callers treat it like pending; the sweep
 * also counts it towards its hourly failure alert.
 */
export type ConfirmOutcome = "fulfilled" | "failed" | "pending" | "check_error" | "needs_review" | "ignored"
export type HubtelPaymentStatus = "pending" | "confirming" | "paid" | "failed" | "needs_review"

export interface HubtelPaymentRow {
  reference: string
  /** What the shared charge handlers look the payment up by; null means the opaque `reference`. Never sent to Hubtel. */
  internal_reference?: string | null
  /** Passed to the shared charge handlers in place of Paystack metadata (Hubtel returns none). */
  metadata?: unknown
  amount_pesewas: number
  status: HubtelPaymentStatus
  created_at: string
  expires_at: string
  claimed_at: string | null
  /** Successful claims so far (migration 0152); the claim RPC increments it. */
  claim_count?: number
  hubtel_transaction_id?: string | null
  charges_pesewas?: number | null
  payment_method?: string | null
  last_check?: unknown
}

export interface RowPatch {
  updated_at: string
  status?: HubtelPaymentStatus
  last_check?: unknown
  hubtel_transaction_id?: string | null
  charges_pesewas?: number | null
  payment_method?: string | null
}

/** The update applies only when the row's status is one of `status` (and claimed_at equals `claimedAt`, if given). */
export interface UpdateGuard { status: HubtelPaymentStatus[]; claimedAt?: string }

export interface HubtelPaymentStore {
  load(reference: string): Promise<HubtelPaymentRow | null>
  /** Atomic claim. Returns the claimed row, or null if another caller holds it / it is final / missing. */
  claim(reference: string): Promise<HubtelPaymentRow | null>
  /** Guarded update. Returns whether a row changed. Throws on a database error. */
  update(reference: string, patch: RowPatch, guard: UpdateGuard): Promise<boolean>
}

type HandlerResponse = Response | null
export interface ConfirmDeps {
  store: HubtelPaymentStore
  checkStatus: (reference: string) => Promise<PaymentStatus>
  onChargeSuccess: (data: ChargeEventData) => Promise<HandlerResponse>
  onChargeFailed: (data: ChargeEventData) => Promise<HandlerResponse>
  notify: (message: string, type: string, reference?: string) => Promise<void>
  now: () => Date
}

const REF_RE = /^[0-9a-f]{32}$/
const STALE_CLAIM_MS = 10 * 60_000
/** On the winning claim with this many claims (i.e. the 3rd attempt), stop calling handlers: needs_review. */
const MAX_CLAIMS = 3
/** A not_found status check later than this after expires_at parks the row for review. Kind `error` never does. */
const NO_RECORD_REVIEW_MS = 24 * 60 * 60_000
/** A failed row younger than this (by created_at) is still checked for a late payment. Matches sweep.ts. */
const LATE_PAYMENT_WINDOW_MS = 72 * 60 * 60_000
const ALERT_TYPE = "hubtel_payment"

/** Mobile money and Hubtel/G-Money wallets only. Anything mentioning "card", or unknown/missing, is refused. */
const ALLOWED_METHODS = new Set(["mobilemoney", "momo", "wallet", "hubtel", "hubtelwallet", "gmoney"])
export function isAllowedPaymentMethod(method: string | undefined | null): boolean {
  if (typeof method !== "string") return false
  const k = method.toLowerCase().replace(/[^a-z]/g, "")
  if (!k || k.includes("card")) return false
  return ALLOWED_METHODS.has(k)
}

const isOk = (res: HandlerResponse) => res === null || (res.status >= 200 && res.status < 300)
const ghs = (p: number | undefined) => (typeof p === "number" ? (p / 100).toFixed(2) : "?")
const hubtelFieldsOf = (status: PaymentStatus) => ({
  hubtel_transaction_id: status.transactionId ?? null,
  charges_pesewas: status.chargesPesewas ?? null,
  payment_method: status.paymentMethod ?? null,
})

export async function confirmHubtelPayment(reference: string, deps?: Partial<ConfirmDeps>): Promise<ConfirmOutcome> {
  if (typeof reference !== "string" || !REF_RE.test(reference)) return "ignored"
  const d = await resolveDeps(deps)
  const stamp = () => d.now().toISOString()
  const alert = async (message: string) => {
    // An alerting failure must never change a money decision.
    try { await d.notify(message, ALERT_TYPE, reference) } catch (e) { console.error("[hubtel-pay] notifyAdmins failed", e) }
  }

  const row = await d.store.load(reference)
  if (!row) return "ignored"

  if (row.status === "failed") {
    // Not `age >= window`: an unreadable created_at must stop here too.
    if (!(d.now().getTime() - new Date(row.created_at).getTime() < LATE_PAYMENT_WINDOW_MS)) return "ignored"
    const late = await d.checkStatus(reference)
    if (late.kind !== "paid") {
      // Only the stamp: last_check keeps what the row was failed on, and the sweep waits an hour before looking again.
      await d.store.update(reference, { updated_at: stamp() }, { status: ["failed"] })
      return "ignored"
    }
    const wrote = await d.store.update(reference,
      { status: "needs_review", ...hubtelFieldsOf(late), last_check: late.raw, updated_at: stamp() }, { status: ["failed"] })
    if (!wrote) return "ignored"
    await alert(`Hubtel payment ${reference} was charged after the payment was marked failed (GHS ${ghs(late.amountPesewas)}). Not fulfilled. Needs review.`)
    return "needs_review"
  }

  const staleConfirming = row.status === "confirming" && row.claimed_at !== null &&
    new Date(row.claimed_at).getTime() < d.now().getTime() - STALE_CLAIM_MS
  if (row.status !== "pending" && !staleConfirming) return "ignored"

  const status = await d.checkStatus(reference)
  const hubtelFields = hubtelFieldsOf(status)
  /** The handlers find the payment by the surface's own reference; the claim and every row write keep the opaque one. */
  const handlerIdentity = { reference: row.internal_reference ?? row.reference, metadata: row.metadata ?? undefined }

  /** Leave the row where it is; just remember what Hubtel said. */
  const recordCheck = async (): Promise<ConfirmOutcome> => {
    await d.store.update(reference, { last_check: status.raw, updated_at: stamp() }, { status: [row.status] })
    return status.kind === "error" ? "check_error" : "pending"
  }

  /** Final write on a row we hold. */
  const finish = async (claimed: HubtelPaymentRow, patch: Omit<RowPatch, "updated_at">): Promise<boolean> => {
    try {
      // Pass claimed_at EXACTLY as the claim returned it. Never normalise it through Date/toISOString:
      // PostgREST returns and compares timestamptz at microsecond precision, and a millisecond string
      // would never match, so every guarded final write would silently change nothing.
      return await d.store.update(reference, { ...patch, last_check: status.raw, updated_at: stamp() },
        { status: ["confirming"], claimedAt: claimed.claimed_at ?? undefined })
    } catch (e) {
      console.error("[hubtel-pay] final write failed", reference, e)
      return false
    }
  }

  /**
   * Hand a claimed row to a human. The alert says "needs review", so it only goes out once that is true. If the write
   * did not land the row stays confirming: log it, and the sweep reclaims it after 10 minutes and tries again.
   */
  const park = async (claimed: HubtelPaymentRow, message: string): Promise<ConfirmOutcome> => {
    if (await finish(claimed, { status: "needs_review", ...hubtelFields })) {
      await alert(message)
      return "needs_review"
    }
    console.error("[hubtel-pay] could not write needs_review; no alert sent, the sweep retries after the claim goes stale", reference)
    return "check_error"
  }

  /** On the MAX_CLAIMS-th winning claim (or later) park the row for a human instead of retrying; null means carry on. */
  const capReached = async (claimed: HubtelPaymentRow): Promise<ConfirmOutcome | null> => {
    if ((claimed.claim_count ?? 0) < MAX_CLAIMS) return null
    return park(claimed, `Hubtel payment ${reference} stuck after ${MAX_CLAIMS} attempts (Hubtel: ${status.kind}); handler not called again. Needs review.`)
  }

  if (status.kind === "paid") {
    const paidP = status.amountPesewas
    let problem: string | null = null
    if (typeof paidP !== "number" || !Number.isSafeInteger(paidP) || paidP < row.amount_pesewas) {
      problem = `paid GHS ${ghs(paidP)} but expected GHS ${ghs(row.amount_pesewas)}`
    } else if (!isAllowedPaymentMethod(status.paymentMethod)) {
      problem = `payment method "${String(status.paymentMethod ?? "none").slice(0, 30)}" is not mobile money/wallet`
    }

    const claimed = await d.store.claim(reference)
    if (!claimed) return "ignored"

    if (problem) {
      await finish(claimed, { status: "needs_review", ...hubtelFields })
      await alert(`Hubtel payment ${reference} needs review: ${problem}. Not fulfilled.`)
      return "needs_review"
    }
    const capped = await capReached(claimed)
    if (capped) return capped

    let res: HandlerResponse
    try {
      // Always OUR amount, even when Hubtel reports more (its fee can sit on top): the real figures stay in last_check
      // and charges_pesewas, and the handler must not credit or re-price on a number the customer never agreed to.
      res = await d.onChargeSuccess({ ...handlerIdentity, amount: row.amount_pesewas, id: status.transactionId, gateway_response: "Hubtel: Paid" })
    } catch (e) {
      console.error("[hubtel-pay] handleChargeSuccess threw", reference, e)
      await alert(`Hubtel payment ${reference}: fulfilment handler threw; left confirming, the sweep retries after 10 min.`)
      return "pending"
    }
    if (!isOk(res)) {
      await finish(claimed, { status: "needs_review", ...hubtelFields })
      await alert(`Hubtel payment ${reference} needs review: Hubtel says Paid (GHS ${ghs(paidP)}) but the fulfilment handler answered ${res!.status}.`)
      return "needs_review"
    }
    const wrote = await finish(claimed, { status: "paid", ...hubtelFields })
    if (!wrote) {
      await alert(`Hubtel payment ${reference}: fulfilled but could not be marked paid; the sweep may re-run the (idempotent) handler.`)
    }
    return "fulfilled"
  }

  const expired = d.now().getTime() >= new Date(row.expires_at).getTime()
  if (status.kind === "refunded" || (status.kind === "unpaid" && expired)) {
    const refunded = status.kind === "refunded"
    const claimed = await d.store.claim(reference)
    if (!claimed) return "ignored"
    const capped = await capReached(claimed)
    if (capped) return capped

    const gateway_response = refunded ? "Hubtel: Refunded" : "Hubtel: Unpaid (expired)"
    let res: HandlerResponse
    try {
      res = await d.onChargeFailed({ ...handlerIdentity, amount: status.amountPesewas ?? row.amount_pesewas, gateway_response })
    } catch (e) {
      console.error("[hubtel-pay] handleChargeFailed threw", reference, e)
      await alert(`Hubtel payment ${reference}: failure handler threw; left confirming, the sweep retries after 10 min.`)
      return "pending"
    }
    if (!isOk(res)) {
      await finish(claimed, { status: "needs_review", ...hubtelFields })
      await alert(`Hubtel payment ${reference} needs review: ${gateway_response}, failure handler answered ${res!.status}.`)
      return "needs_review"
    }
    await finish(claimed, { status: "failed", ...hubtelFields })
    if (refunded) await alert(`Hubtel payment ${reference} was REFUNDED by Hubtel (GHS ${ghs(status.amountPesewas)}); marked failed.`)
    return "failed"
  }

  // not_found long after expiry: nothing will ever settle this row, so hand it to a human (never failed: no record is
  // not proof of no payment). Same atomic claim, so concurrent callers produce one alert. Kind `error` never gets here:
  // an outage says nothing about the payment, and a long outage must not park every open row.
  if (status.kind === "not_found" && d.now().getTime() > new Date(row.expires_at).getTime() + NO_RECORD_REVIEW_MS) {
    const claimed = await d.store.claim(reference)
    if (!claimed) return "ignored"
    return park(claimed, `Hubtel payment ${reference} needs review: no Hubtel record 24h after expiry (status check: ${status.kind}). Not fulfilled.`)
  }

  // unpaid before expiry, not_found, error: never fail, never fulfil.
  return recordCheck()
}

async function resolveDeps(deps: Partial<ConfirmDeps> = {}): Promise<ConfirmDeps> {
  // Imported lazily: charge-events and sms-service build Supabase clients at module load.
  const needEvents = !deps.onChargeSuccess || !deps.onChargeFailed
  const events = needEvents ? await import("@/lib/payments/charge-events") : null
  const notify = deps.notify ?? (async (m: string, t: string, r?: string) => {
    const { notifyAdmins } = await import("@/lib/sms-service")
    await notifyAdmins(m, t, r)
  })
  return {
    store: deps.store ?? (await supabaseStore()),
    checkStatus: deps.checkStatus ?? ((ref) => checkPaymentStatus(ref)),
    onChargeSuccess: deps.onChargeSuccess ?? events!.handleChargeSuccess,
    onChargeFailed: deps.onChargeFailed ?? events!.handleChargeFailed,
    notify,
    now: deps.now ?? (() => new Date()),
  }
}

export const ROW_COLUMNS = "reference, internal_reference, metadata, amount_pesewas, status, created_at, expires_at, claimed_at"

async function supabaseStore(): Promise<HubtelPaymentStore> {
  const { createClient } = await import("@supabase/supabase-js")
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
  return {
    async load(reference) {
      const { data, error } = await sb.from("hubtel_payments").select(ROW_COLUMNS).eq("reference", reference).maybeSingle()
      if (error) throw new Error(`hubtel_payments load failed: ${error.message}`)
      return (data as HubtelPaymentRow | null) ?? null
    },
    async claim(reference) {
      const { data, error } = await sb.rpc("claim_hubtel_payment", { p_reference: reference })
      if (error) throw new Error(`claim_hubtel_payment failed: ${error.message}`)
      const rows = (Array.isArray(data) ? data : data ? [data] : []) as HubtelPaymentRow[]
      return rows[0] ?? null
    },
    async update(reference, patch, guard) {
      let q = sb.from("hubtel_payments").update(patch).eq("reference", reference).in("status", guard.status)
      if (guard.claimedAt !== undefined) q = q.eq("claimed_at", guard.claimedAt)
      const { data, error } = await q.select("reference")
      if (error) throw new Error(`hubtel_payments update failed: ${error.message}`)
      return (data?.length ?? 0) > 0
    },
  }
}
