import { createClient } from "@supabase/supabase-js"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function getShopPref(phone: string): Promise<{ shopCodeId: string } | null> {
  const { data } = await supabase
    .from("wa_shop_customer_prefs")
    .select("shop_code_id")
    .eq("phone", phone)
    .maybeSingle()
  return data ? { shopCodeId: data.shop_code_id } : null
}

export async function setShopPref(phone: string, shopCodeId: string): Promise<void> {
  await supabase
    .from("wa_shop_customer_prefs")
    .upsert({ phone, shop_code_id: shopCodeId, last_used_at: new Date().toISOString() })
}

export async function clearShopPref(phone: string): Promise<void> {
  await supabase
    .from("wa_shop_customer_prefs")
    .delete()
    .eq("phone", phone)
}
