import { createClient, type SupabaseClient } from "@supabase/supabase-js"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

/**
 * Get both formats of a phone number for blacklist comparison
 * @param phoneNumber - Phone number (e.g., "0243123456" or "243123456")
 * @returns Array with both formats: without leading 0 and with leading 0
 */
export function getBlacklistFormats(phoneNumber: string): string[] {
  const cleaned = phoneNumber.replace(/\D/g, "")
  const withoutZero = cleaned.startsWith("0") ? cleaned.substring(1) : cleaned
  const withZero = cleaned.startsWith("0") ? cleaned : "0" + cleaned
  return [withoutZero, withZero]
}

/**
 * Check if a phone number is blacklisted
 * Checks both formats (with and without leading 0) to match regardless of storage format
 */
export async function isPhoneBlacklisted(phoneNumber: string): Promise<boolean> {
  try {
    const formats = getBlacklistFormats(phoneNumber)
    
    const { data, error } = await supabase
      .from("blacklisted_phone_numbers")
      .select("id")
      .in("phone_number", formats)
      .limit(1)

    if (error) {
      console.error("[BLACKLIST] Error checking blacklist:", error)
      return false
    }

    return data && data.length > 0
  } catch (error) {
    console.error("[BLACKLIST] Error checking phone:", error)
    return false
  }
}

/**
 * Get blacklist entry for a phone number
 * Checks both formats (with and without leading 0) to match regardless of storage format
 */
export async function getBlacklistEntry(phoneNumber: string) {
  try {
    const formats = getBlacklistFormats(phoneNumber)
    
    const { data, error } = await supabase
      .from("blacklisted_phone_numbers")
      .select("*")
      .in("phone_number", formats)
      .limit(1)

    if (error) {
      console.error("[BLACKLIST] Error fetching entry:", error)
      return null
    }

    return data && data.length > 0 ? data[0] : null
  } catch (error) {
    console.error("[BLACKLIST] Error:", error)
    return null
  }
}

/**
 * Bulk form of isPhoneBlacklisted for a page of users: which of `phones` are blacklisted, in one query.
 * Same matching (getBlacklistFormats: with and without the leading 0). Returns the input strings that matched.
 * Throws on a query error (the caller decides how to degrade); isPhoneBlacklisted fails open instead.
 */
export async function findBlacklistedPhones(phones: Iterable<string | null | undefined>, db: SupabaseClient = supabase): Promise<Set<string>> {
  const formsByPhone = new Map<string, string[]>()
  for (const p of phones) {
    if (!p || !p.replace(/\D/g, "")) continue
    if (!formsByPhone.has(p)) formsByPhone.set(p, getBlacklistFormats(p))
  }
  const all = [...new Set([...formsByPhone.values()].flat())]
  if (all.length === 0) return new Set()
  const { data, error } = await db.from("blacklisted_phone_numbers").select("phone_number").in("phone_number", all)
  if (error) throw new Error(`blacklist lookup failed: ${error.message}`)
  const hit = new Set((data ?? []).map((r: { phone_number: string }) => r.phone_number))
  const out = new Set<string>()
  for (const [phone, forms] of formsByPhone) if (forms.some((f) => hit.has(f))) out.add(phone)
  return out
}
