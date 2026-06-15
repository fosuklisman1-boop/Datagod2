// lib/whatsapp-bot/account-link.ts
//
// Maps a WhatsApp number to a Datagod account after OTP ownership verification
// (see account-verify.ts). Lets a customer who messages from a number other than
// their account number still act on their own account in chat.
import { createClient } from "@supabase/supabase-js"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

/** The Datagod user id linked to this WhatsApp number, or null. */
export async function resolveLinkedUserId(waPhone: string): Promise<string | null> {
  if (!waPhone) return null
  try {
    const { data } = await supabase
      .from("whatsapp_account_links")
      .select("user_id")
      .eq("whatsapp_phone", waPhone)
      .maybeSingle()
    return data?.user_id ?? null
  } catch {
    return null
  }
}

/** Persistently link a WhatsApp number to an account (one account per number). */
export async function linkWhatsAppToAccount(waPhone: string, userId: string): Promise<void> {
  await supabase
    .from("whatsapp_account_links")
    .upsert(
      { whatsapp_phone: waPhone, user_id: userId, verified_at: new Date().toISOString() },
      { onConflict: "whatsapp_phone" }
    )
}
