// Live wallet balance of one ACCOUNT (by user id), for the main WhatsApp bot's "Pay via Wallet" confirm.
// The chat's account is `session.userId`: the sender's own registered account, or an OTP-linked account registered on
// another phone (lib/ai-tools.ts / the webhook's resolveLinkedUserId). The wallet debit (handlePaymentMethod and
// friends, deduct_wallet) uses that same id, so the eligibility check must read that account's wallet, never the one
// registered on the sender's phone number (resolveDialer).
import { createClient } from "@supabase/supabase-js"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

/**
 * The account's wallet balance: a missing wallet row is 0 (as resolveDialer); a missing user id or a read error is
 * `undefined`, which every caller treats as "cannot pay by wallet" (fail closed: the bot asks for a MoMo number).
 */
export async function liveWalletBalance(userId: string | undefined | null): Promise<number | undefined> {
  if (!userId) return undefined
  try {
    const { data, error } = await supabase.from("wallets").select("balance").eq("user_id", userId).maybeSingle()
    if (error) return undefined
    const n = data ? Number(data.balance) : 0
    return Number.isFinite(n) ? n : undefined
  } catch {
    return undefined
  }
}
