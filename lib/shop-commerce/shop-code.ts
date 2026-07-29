import { createClient } from "@supabase/supabase-js"

// Channel-agnostic shop-code resolver. Extracted from the lookup portion of
// lib/ussd-shop/handlers/shop.ts's handleEnterShopCode, so both the USSD shop
// and the WhatsApp shop bot can share the exact same "what does this code
// mean" logic. Deliberately does NOT deduct tokens, build network lists, or
// write session state — those stay channel-specific and live in the callers.
// It also does NOT gate on status/token balance/activation — it just resolves
// and reports the facts; the caller decides whether the code is "usable".

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// Using `typeof supabase` (rather than `ReturnType<typeof createClient>`) keeps the
// exact instantiated generic type — createClient's default type params don't survive
// ReturnType applied to the uninstantiated generic function.
type SupabaseClientLike = typeof supabase

export interface ResolvedShopCode {
  shopCodeId: string
  shopId: string
  shopName: string
  parentShopId: string | null
  status: string
  tokenBalance: number
  whatsappActivated: boolean
}

export async function resolveShopCode(
  code: string,
  client: SupabaseClientLike = supabase
): Promise<ResolvedShopCode | null> {
  const { data: shopCode } = await client
    .from("ussd_shop_codes")
    .select("id, shop_id, status, token_balance, whatsapp_activated")
    .eq("code", code.trim())
    .maybeSingle()

  if (!shopCode) return null

  const { data: shopRow } = await client
    .from("user_shops")
    .select("shop_name, parent_shop_id")
    .eq("id", shopCode.shop_id)
    .single()

  return {
    shopCodeId: shopCode.id,
    shopId: shopCode.shop_id,
    shopName: shopRow?.shop_name ?? 'Shop',
    parentShopId: (shopRow as any)?.parent_shop_id ?? null,
    status: shopCode.status,
    tokenBalance: shopCode.token_balance,
    whatsappActivated: shopCode.whatsapp_activated === true,
  }
}
