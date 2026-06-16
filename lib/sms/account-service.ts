import { createClient } from "@supabase/supabase-js"
import { deriveOwnerType, type OwnerContext } from "./foundation-rules"

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export interface SmsAccount {
  id: string
  user_id: string
  owner_type: string
  owner_id: string | null
  unit_balance: number
  status: string
}

/** Resolve the owner context from role + user_shops membership.
 *  A user_shops row with parent_shop_id set is a SUB-AGENT shop; otherwise a SHOP owner. */
async function resolveOwnerContext(userId: string): Promise<OwnerContext | null> {
  const { data: u } = await supabaseAdmin.from("users").select("role").eq("id", userId).maybeSingle()
  if (u?.role === "admin") return deriveOwnerType({ role: "admin", ownsShop: false, isSubAgent: false })

  const { data: shop } = await supabaseAdmin
    .from("user_shops").select("id, parent_shop_id").eq("user_id", userId).maybeSingle()

  const isSub = !!shop && shop.parent_shop_id != null
  return deriveOwnerType({
    role: u?.role ?? "user",
    ownsShop: !!shop && !isSub,
    isSubAgent: isSub,
    shopId: shop?.id,
    subAgentId: shop?.id,
  })
}

/** Idempotently create (or fetch) the caller's SMS account. Returns null if the user is
 *  not entitled (plain user with no shop/sub-agent and not admin). */
export async function getOrCreateAccountForUser(userId: string): Promise<SmsAccount | null> {
  const ctx = await resolveOwnerContext(userId)
  if (!ctx) return null

  const { data: id, error } = await supabaseAdmin.rpc("get_or_create_sms_account", {
    p_user_id: userId,
    p_owner_type: ctx.ownerType,
    p_owner_id: ctx.ownerId,
  })
  if (error || !id) return null

  const { data: account } = await supabaseAdmin
    .from("sms_accounts").select("*").eq("id", id).single()
  return (account as SmsAccount) ?? null
}

/** Sum of units paid-for but still pending wholesale backing. */
export async function getPendingUnits(accountId: string): Promise<number> {
  const { data } = await supabaseAdmin
    .from("sms_pending_credits").select("units")
    .eq("sms_account_id", accountId).eq("status", "pending")
  return (data ?? []).reduce((s: number, r: { units: number | null }) => s + (r.units || 0), 0)
}

export async function listUnitTransactions(accountId: string, limit = 50) {
  const { data } = await supabaseAdmin
    .from("sms_unit_transactions")
    .select("*")
    .eq("sms_account_id", accountId)
    .order("created_at", { ascending: false })
    .limit(limit)
  return data ?? []
}
