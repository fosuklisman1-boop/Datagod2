// lib/sms/activation-service.ts
import { createClient } from "@supabase/supabase-js"
import { getWholesaleCredits } from "./wholesale"
import { notifyAdminSmsShortfall } from "./notify"
import { isSmsEnabled } from "./kill-switch"
import type { Gateway } from "@/lib/payment-gateway/config"

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export interface ActivationResult {
  ok: boolean
  error?: string
  alreadyDone?: boolean
}

/** A start's answer. httpStatus and code are set when the gateway layer refused; the route defaults to 400. */
export interface ActivationStartResult {
  ok: boolean
  reference?: string
  error?: string
  code?: string
  httpStatus?: number
}

export interface BonusResult {
  ok: boolean
  error?: string
  pending?: boolean
  unitsCredited?: number
}

/** Fetch the activation fee from tenant_global_settings. Returns 0 on error (fail-open
 *  for reads — the gate enforcement is inside the SQL RPC, not here). */
async function fetchActivationFee(): Promise<number> {
  const { data } = await supabaseAdmin
    .from("tenant_global_settings")
    .select("value")
    .eq("key", "sms_activation_fee")
    .single()
  return Number((data?.value as { amount?: number })?.amount ?? 0)
}

/** Fetch account row. Returns null if not found. */
async function fetchAccount(accountId: string): Promise<{ id: string; status: string; owner_type: string } | null> {
  const { data } = await supabaseAdmin
    .from("sms_accounts")
    .select("id, status, owner_type")
    .eq("id", accountId)
    .maybeSingle()
  return data as { id: string; status: string; owner_type: string } | null
}

/** Activate via cash wallet. The activate_sms_account RPC debits the wallet AND flips status
 *  to active ATOMICALLY (single transaction, guarded so concurrent calls can't double-charge),
 *  so there is no separate service-level debit or refund. Platform accounts are pre-active.
 *  (userId is accepted for signature stability; the RPC derives the wallet from the account.) */
export async function activateViaWallet(_userId: string, accountId: string): Promise<ActivationResult> {
  if (!(await isSmsEnabled())) return { ok: false, error: "SMS_DISABLED" }
  const account = await fetchAccount(accountId)
  if (!account) return { ok: false, error: "Account not found" }

  // Fast-fail pre-checks (the RPC is the authority; these just avoid a needless RPC round-trip).
  if (account.owner_type === "platform") return { ok: true }            // pre-active
  if (account.status === "active") return { ok: false, error: "ALREADY_ACTIVATED" }
  if (account.status === "suspended") return { ok: false, error: "SUSPENDED" }

  const { error: rpcErr } = await supabaseAdmin.rpc("activate_sms_account", {
    p_account_id: accountId,
    p_paid_from: "wallet",
  })
  if (rpcErr) {
    const m = rpcErr.message || ""
    if (m.includes("INSUFFICIENT_BALANCE")) return { ok: false, error: "INSUFFICIENT_BALANCE" }
    if (m.includes("ALREADY_ACTIVATED")) return { ok: false, error: "ALREADY_ACTIVATED" }
    if (m.includes("SUSPENDED")) return { ok: false, error: "SUSPENDED" }
    return { ok: false, error: "Activation failed" }
  }
  return { ok: true }
}

/** Initialize a Paystack activation payment. Returns the Paystack authorizationUrl.
 *  The webhook finalizes activation when the payment lands. */
export async function initActivationPaystack(
  userId: string,
  accountId: string,
  userEmail: string,
  channels?: string[],
  opts: { redirectUrl?: () => Promise<string> } = {},
): Promise<ActivationStartResult & { authorizationUrl?: string }> {
  if (!(await isSmsEnabled())) return { ok: false, error: "SMS_DISABLED" }
  const account = await fetchAccount(accountId)
  if (!account) return { ok: false, error: "Account not found" }
  if (account.owner_type === "platform") return { ok: false, error: "Platform accounts do not require activation" }
  if (account.status === "active") return { ok: false, error: "ALREADY_ACTIVATED" }
  if (account.status === "suspended") return { ok: false, error: "SUSPENDED" }

  const fee = await fetchActivationFee()
  if (fee <= 0) return { ok: false, error: "Activation fee not configured" }

  // When direct charge is the legit path, `channels` strips mobile_money so the hosted page
  // can't prompt an arbitrary victim number (mirrors the Buy-Credits route). Only Paystack can
  // strip it, so such a request stays there.
  const { SMS_SURFACE, smsHostedGateway, smsStartRefusal } = await import("./gateway-start")
  const gateway = await smsHostedGateway(!!channels, fee)
  const reused = await activationReplay(accountId, gateway)
  if (reused.kind === "refuse") return { ok: false, error: reused.body.error, code: reused.body.code, httpStatus: reused.status }
  const reference = reused.kind === "replay" ? reused.reference : `smsactivate-${accountId}-${Date.now()}`
  const params = {
    email: userEmail,
    amount: fee,
    reference,
    purpose: "SMS Account Activation",
    channels,
    metadata: {
      type: "sms_activation",
      sms_account_id: accountId,
      fee,
    },
    // Paystack returns to its dashboard's callback; Hubtel's return route needs somewhere to send the customer.
    ...(gateway === "hubtel" && opts.redirectUrl ? { redirectUrl: await opts.redirectUrl() } : {}),
  }

  try {
    const { initializePayment } = await import("@/lib/paystack")
    const { startHostedPayment } = await import("@/lib/payment-gateway/start")
    const init = channels
      ? await initializePayment(params)
      : await startHostedPayment(SMS_SURFACE, { ...params, reusedReference: reused.kind === "replay" })
    return { ok: true, authorizationUrl: init.authorizationUrl, reference: init.reference }
  } catch (e) {
    const refusal = smsStartRefusal(e)
    if (!refusal) throw e
    return { ok: false, error: refusal.body.error, code: refusal.body.code, httpStatus: refusal.status }
  }
}

async function activationReplay(accountId: string, gateway: Gateway) {
  const { decideAttemptReplay } = await import("@/lib/payment-gateway/web-replay")
  return decideAttemptReplay(supabaseAdmin, "sms", gateway, { prefix: `smsactivate-${accountId}-` })
}

/** Direct MoMo charge for activation (on-page prompt, no redirect). The
 *  charge.success webhook (sms_activation branch) finalizes activation, exactly like
 *  the redirect path. Used only when the activation fee > 0 (a 0 fee activates free
 *  via the wallet path). */
export async function initActivationDirectCharge(
  _userId: string,
  accountId: string,
  userEmail: string,
  phone: string,
  provider: "mtn" | "vod" | "tgo",
  /** Set by the route once it has checked the number; only then can the charge go to Hubtel. */
  opts: { verifiedPayer?: boolean } = {},
): Promise<ActivationStartResult & { status?: string }> {
  if (!(await isSmsEnabled())) return { ok: false, error: "SMS_DISABLED" }
  const account = await fetchAccount(accountId)
  if (!account) return { ok: false, error: "Account not found" }
  if (account.owner_type === "platform") return { ok: false, error: "Platform accounts do not require activation" }
  if (account.status === "active") return { ok: false, error: "ALREADY_ACTIVATED" }
  if (account.status === "suspended") return { ok: false, error: "SUSPENDED" }

  const fee = await fetchActivationFee()
  if (fee <= 0) return { ok: false, error: "Activation is free — activate from your wallet." }

  const verifiedPayer = opts.verifiedPayer === true
  const reused = await activationReplay(accountId, verifiedPayer ? "hubtel" : "paystack")
  if (reused.kind === "refuse") return { ok: false, error: reused.body.error, code: reused.body.code, httpStatus: reused.status }
  const reference = reused.kind === "replay" ? reused.reference : `smsactivate-${accountId}-${Date.now()}`
  const { SMS_SURFACE, smsStartRefusal } = await import("./gateway-start")
  const { startMomoCharge } = await import("@/lib/payment-gateway/start")
  try {
    const charge = await startMomoCharge(SMS_SURFACE, {
      email: userEmail, amount: fee, phone, provider, reference,
      metadata: { type: "sms_activation", sms_account_id: accountId, fee },
      channel: "sms_activation_momo", purpose: "SMS Account Activation",
      verifiedPayer, reusedReference: reused.kind === "replay",
    })
    return { ok: true, reference, status: charge.status }
  } catch (e) {
    const refusal = smsStartRefusal(e)
    if (!refusal) throw e
    return { ok: false, error: refusal.body.error, code: refusal.body.code, httpStatus: refusal.status }
  }
}

/** Finalize activation from the Paystack webhook. Idempotent via the account's status: a
 *  replayed webhook for an already-active account raises ALREADY_ACTIVATED, which we map to
 *  a no-op success (alreadyDone). Fails CLOSED if the fee can't be read (won't activate on an
 *  unverified amount). (paystackRef is accepted for signature stability / future ledger use.) */
export async function finalizeActivationPaystack(
  accountId: string,
  _paystackRef: string,
  amountPaidGhs: number
): Promise<ActivationResult> {
  const fee = await fetchActivationFee()
  // Fail CLOSED: a failed/zero fee read must NOT skip the underpayment check and activate.
  if (fee <= 0) return { ok: false, error: "Activation fee not configured" }
  if (amountPaidGhs < fee - 0.01) {
    return { ok: false, error: `Underpayment: paid ${amountPaidGhs} < fee ${fee}` }
  }

  const { error: rpcErr } = await supabaseAdmin.rpc("activate_sms_account", {
    p_account_id: accountId,
    p_paid_from: "paystack",
  })

  if (rpcErr) {
    if (rpcErr.message?.includes("ALREADY_ACTIVATED")) {
      return { ok: true, alreadyDone: true }
    }
    return { ok: false, error: rpcErr.message }
  }

  return { ok: true }
}

/** Claim the one-time welcome bonus. Solvency-gated via claim_sms_welcome_bonus RPC
 *  (which internally calls credit_sms_units_if_solvent). */
export async function claimWelcomeBonus(accountId: string): Promise<BonusResult> {
  if (!(await isSmsEnabled())) return { ok: false, error: "SMS_DISABLED" }
  const wholesale = await getWholesaleCredits()
  const { data, error: rpcErr } = await supabaseAdmin.rpc("claim_sms_welcome_bonus", {
    p_account_id: accountId,
    p_wholesale: wholesale,
  })

  if (rpcErr) {
    if (rpcErr.message?.includes("ALREADY_CLAIMED")) return { ok: false, error: "ALREADY_CLAIMED" }
    return { ok: false, error: "Failed to claim bonus" }
  }

  const row = (data as Array<{ units_credited: number; outcome: string }>)?.[0]
  const pending = row?.outcome === "pending"
  if (pending) notifyAdminSmsShortfall(row?.units_credited ?? 0).catch(() => {})

  return { ok: true, pending, unitsCredited: row?.units_credited ?? 0 }
}
