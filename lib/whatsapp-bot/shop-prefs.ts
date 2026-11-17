import { createClient } from "@supabase/supabase-js"
import { getCustomerShopCodeId, rememberCustomerShop } from "@/lib/shop-commerce/customer-prefs"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// The WhatsApp shop bot shares one remembered shop per phone with USSD and SMS (public.shop_customer_prefs).
// Failures never reach the caller: a failed read is "no remembered shop", a failed write is skipped.
// Nothing here deletes a preference; a shop that cannot be used right now simply falls through to code entry.

export async function getShopPref(phone: string): Promise<{ shopCodeId: string } | null> {
  try {
    const id = await getCustomerShopCodeId(supabase, phone)
    return id ? { shopCodeId: id } : null
  } catch {
    return null
  }
}

export async function setShopPref(phone: string, shopCodeId: string): Promise<void> {
  try {
    await rememberCustomerShop(supabase, phone, shopCodeId, "whatsapp")
  } catch (e) {
    console.error("setShopPref failed", { message: e instanceof Error ? e.message : "unknown" })
  }
}
