// lib/sms/activation-service.ts
import { createClient } from "@supabase/supabase-js"
import { queryMoolreSmsBalance } from "@/lib/sms-service"
import { notifyAdminSmsShortfall } from "./notify"

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export interface ActivationResult {
  ok: boolean
  error?: string
  alreadyDone?: boolean
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
  userEmail: string
): Promise<{ ok: boolean; authorizationUrl?: string; reference?: string; error?: string }> {
  const account = await fetchAccount(accountId)
  if (!account) return { ok: false, error: "Account not found" }
  if (account.owner_type === "platform") return { ok: false, error: "Platform accounts do not require activation" }
  if (account.status === "active") return { ok: false, error: "ALREADY_ACTIVATED" }
  if (account.status === "suspended") return { ok: false, error: "SUSPENDED" }

  const fee = await fetchActivationFee()
  if (fee <= 0) return { ok: false, error: "Activation fee not configured" }

  const { initializePayment } = await import("@/lib/paystack")
  const reference = `smsactivate-${accountId}-${Date.now()}`
  const init = await initializePayment({
    email: userEmail,
    amount: fee,
    reference,
    purpose: "SMS Account Activation",
    metadata: {
      type: "sms_activation",
      sms_account_id: accountId,
      fee,
    },
  })

  return { ok: true, authorizationUrl: init.authorizationUrl, reference: init.reference }
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
  const wholesale = await queryMoolreSmsBalance()
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
