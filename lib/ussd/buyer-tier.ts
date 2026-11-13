import type { SupabaseClient } from "@supabase/supabase-js"

export type BuyerTier = {
  /** "regular" | "dealer" | "sub_agent", or another tier name held in app_settings.ussd_price_tier. */
  effectivePriceTier: string
  subAgentParentShopId?: string
  userId?: string
  walletBalance?: number
  mtnWhitelistActive: boolean
}

/**
 * Resolve the buyer's effective price tier from their account role. Shared by the USSD network step and the
 * SMS lane so both price an order the same way. Moved verbatim out of handleSelectNetwork.
 */
export async function resolveBuyerTier(
  supabase: SupabaseClient,
  dialingPhone: string,
  networkDbName: string
): Promise<BuyerTier> {
  const localPhone = dialingPhone.startsWith('+233') ? '0' + dialingPhone.slice(4)
    : dialingPhone.startsWith('233') ? '0' + dialingPhone.slice(3)
    : dialingPhone

  const [{ data: userRow }, { data: settingsRow }, { data: mtnProviderRow }] = await Promise.all([
    supabase.from("users").select("id, role").eq("phone_number", localPhone).maybeSingle(),
    supabase.from("app_settings").select("ussd_price_tier").is("key", null).single(),
    networkDbName === 'MTN'
      ? supabase.from("admin_settings").select("value").eq("key", "mtn_provider_selection").maybeSingle()
      : Promise.resolve({ data: null }),
  ])
  const mtnWhitelistActive = networkDbName === 'MTN' &&
    ['xpress', 'codecraft'].includes(mtnProviderRow?.value?.provider ?? '')

  let effectivePriceTier: string = settingsRow?.ussd_price_tier ?? 'regular'
  let subAgentParentShopId: string | undefined
  let walletBalance: number | undefined

  if (userRow) {
    if (userRow.role === 'dealer') {
      effectivePriceTier = 'dealer'
      const { data: walletRow } = await supabase
        .from("wallets").select("balance").eq("user_id", userRow.id).maybeSingle()
      walletBalance = walletRow ? Number(walletRow.balance) : undefined
    } else if (userRow.role === 'sub_agent') {
      const [{ data: shopRow }, { data: walletRow }] = await Promise.all([
        supabase.from("user_shops").select("parent_shop_id").eq("user_id", userRow.id).not("parent_shop_id", "is", null).maybeSingle(),
        supabase.from("wallets").select("balance").eq("user_id", userRow.id).maybeSingle(),
      ])
      walletBalance = walletRow ? Number(walletRow.balance) : undefined
      if (shopRow?.parent_shop_id) {
        effectivePriceTier = 'sub_agent'
        subAgentParentShopId = shopRow.parent_shop_id
      } else {
        effectivePriceTier = 'regular'
      }
    } else {
      effectivePriceTier = 'regular'
      const { data: walletRow } = await supabase
        .from("wallets").select("balance").eq("user_id", userRow.id).maybeSingle()
      walletBalance = walletRow ? Number(walletRow.balance) : undefined
    }
  }

  return { effectivePriceTier, subAgentParentShopId, userId: userRow?.id, walletBalance, mtnWhitelistActive }
}
