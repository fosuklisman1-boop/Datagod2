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

// Links expire so a recycled WhatsApp number can't retain account access
// indefinitely; the customer simply re-verifies after this window.
const LINK_TTL_MS = 180 * 24 * 60 * 60 * 1000 // 180 days

/** The Datagod user id linked to this WhatsApp number, or null (also null if the
 *  link has expired — expired links are removed lazily on read). */
export async function resolveLinkedUserId(waPhone: string): Promise<string | null> {
  if (!waPhone) return null
  try {
    const { data } = await supabase
      .from("whatsapp_account_links")
      .select("user_id, verified_at")
      .eq("whatsapp_phone", waPhone)
      .maybeSingle()
    if (!data?.user_id) return null
    const verifiedAt = data.verified_at ? new Date(data.verified_at).getTime() : 0
    if (Date.now() - verifiedAt > LINK_TTL_MS) {
      // Expired — clear it so the next message starts fresh / re-verifies.
      await supabase.from("whatsapp_account_links").delete().eq("whatsapp_phone", waPhone)
      return null
    }
    return data.user_id
  } catch {
    return null
  }
}

/** Remove the link for a WhatsApp number (customer-initiated "unlink"). Returns
 *  true if a link existed. */
export async function unlinkWhatsApp(waPhone: string): Promise<boolean> {
  if (!waPhone) return false
  try {
    const { data } = await supabase
      .from("whatsapp_account_links")
      .delete()
      .eq("whatsapp_phone", waPhone)
      .select("id")
    return (data?.length ?? 0) > 0
  } catch {
    return false
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
