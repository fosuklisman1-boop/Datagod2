import { createClient } from "@supabase/supabase-js"
import { getDealerRateTier } from "@/lib/sub-agents/dealer-rates"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export interface DialerInfo {
  userId?: string
  role?: string
  balance?: number   // wallet balance (only set for registered dialers)
  email?: string     // real account email (NOT the synthetic Paystack fallback)
  rateTier?: "customer" | "dealer" // dealer-rate decision (sub-agents can have dealer rates turned off per shop)
}

function toLocal(phone: string): string {
  if (phone.startsWith("+233")) return "0" + phone.slice(4)
  if (phone.startsWith("233")) return "0" + phone.slice(3)
  return phone
}

/**
 * Resolves the dialing phone to a registered user (if any) plus their role and
 * wallet balance. Used by the main USSD airtime/RC flows to decide whether to
 * offer the wallet payment option and which fee tier applies. Returns an empty
 * object for unregistered callers (they pay by MoMo).
 */
export async function resolveDialer(dialingPhone: string): Promise<DialerInfo> {
  const local = toLocal(dialingPhone)
  const { data: u } = await supabase
    .from("users")
    .select("id, role, email")
    .eq("phone_number", local)
    .maybeSingle()
  if (!u) return {}

  const { data: w } = await supabase
    .from("wallets")
    .select("balance")
    .eq("user_id", u.id)
    .maybeSingle()

  // Only sub-agents need the extra shop read; a failed read charges the customer rate (shown before payment).
  let rateTier: "customer" | "dealer" = u.role === "dealer" ? "dealer" : "customer"
  if (u.role === "sub_agent") {
    try { rateTier = await getDealerRateTier(supabase, u.id) } catch { rateTier = "customer" }
  }

  return {
    userId: u.id,
    role: u.role ?? undefined,
    balance: w ? Number(w.balance) : 0,
    email: u.email ?? undefined,
    rateTier,
  }
}
