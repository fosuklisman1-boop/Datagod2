// lib/hubtel-pay/confirm.ts
// Decides whether one Hubtel payment is paid and fulfils it exactly once.
//
// Never trusts a callback: the decision comes from the relay status check. Before ANY final transition (paid,
// failed, needs_review) the row is claimed with ONE conditional update (RPC claim_hubtel_payment, migration 0152):
// pending -> confirming, or a confirming claim older than 10 minutes. Only the caller that gets the row back
// continues, so a callback and the sweep arriving together cause at most one handler call and one alert.
// Every write after the claim is guarded on status='confirming' AND our claimed_at.
import type { ChargeEventData } from "@/lib/payments/charge-events"
import { checkPaymentStatus, type PaymentStatus } from "./client"

export type ConfirmOutcome = "fulfilled" | "failed" | "pending" | "needs_review" | "ignored"
export type HubtelPaymentStatus = "pending" | "confirming" | "paid" | "failed" | "needs_review"

export interface HubtelPaymentRow {
  reference: string
  amount_pesewas: number
  status: HubtelPaymentStatus
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
  const staleConfirming = row.status === "confirming" && row.claimed_at !== null &&
    new Date(row.claimed_at).getTime() < d.now().getTime() - STALE_CLAIM_MS
  if (row.status !== "pending" && !staleConfirming) return "ignored"

  const status = await d.checkStatus(reference)

  /** Leave the row where it is; just remember what Hubtel said. */
  const recordCheck = async (): Promise<ConfirmOutcome> => {
    await d.store.update(reference, { last_check: status.raw, updated_at: stamp() }, { status: [row.status] })
    return "pending"
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

  /** True when this winning claim is the MAX_CLAIMS-th (or later): park it for a human instead of retrying. */
  const capReached = async (claimed: HubtelPaymentRow): Promise<boolean> => {
    if ((claimed.claim_count ?? 0) < MAX_CLAIMS) return false
    await finish(claimed, { status: "needs_review", ...hubtelFields })
    await alert(`Hubtel payment ${reference} stuck after ${MAX_CLAIMS} attempts (Hubtel: ${status.kind}); handler not called again. Needs review.`)
    return true
  }

  const hubtelFields = {
    hubtel_transaction_id: status.transactionId ?? null,
    charges_pesewas: status.chargesPesewas ?? null,
    payment_method: status.paymentMethod ?? null,
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
    if (await capReached(claimed)) return "needs_review"

    let res: HandlerResponse
    try {
      res = await d.onChargeSuccess({ reference, amount: paidP!, id: status.transactionId, gateway_response: "Hubtel: Paid" })
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
    if (await capReached(claimed)) return "needs_review"

    const gateway_response = refunded ? "Hubtel: Refunded" : "Hubtel: Unpaid (expired)"
    let res: HandlerResponse
    try {
      res = await d.onChargeFailed({ reference, amount: status.amountPesewas ?? row.amount_pesewas, gateway_response })
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

const ROW_COLUMNS = "reference, amount_pesewas, status, expires_at, claimed_at"

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
