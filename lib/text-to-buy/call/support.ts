import type { SupabaseClient } from "@supabase/supabase-js"

/**
 * Datagod's WhatsApp support number, digits only (the wa.me link form), read live from support_settings.support_whatsapp.
 * Null when it is empty, implausible or unreadable: the caller then sends nothing (never a blank or wrong number).
 * Never logs and never throws.
 */
export async function readSupportWhatsapp(db: Pick<SupabaseClient, "from">): Promise<string | null> {
  try {
    const { data, error } = await db.from("support_settings").select("support_whatsapp").limit(1).maybeSingle()
    if (error) return null
    const raw = (data as { support_whatsapp?: unknown } | null)?.support_whatsapp
    if (typeof raw !== "string") return null
    const digits = raw.replace(/\D/g, "")
    return digits.length >= 8 && digits.length <= 15 ? digits : null
  } catch {
    return null
  }
}
