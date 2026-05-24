import { createClient } from "@supabase/supabase-js"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

/**
 * Get both formats of a phone number for blacklist comparison
 * @param phoneNumber - Phone number (e.g., "0243123456" or "243123456")
 * @returns Array with both formats: without leading 0 and with leading 0
 */
function getBlacklistFormats(phoneNumber: string): string[] {
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
 * Check multiple phone numbers against the blacklist in a single query.
 * Returns a Set of the original phone numbers (as passed in) that are blacklisted.
 */
export async function getBatchBlacklisted(phoneNumbers: string[]): Promise<Set<string>> {
  if (phoneNumbers.length === 0) return new Set()
  try {
    const allFormats = phoneNumbers.flatMap(getBlacklistFormats)
    const { data, error } = await supabase
      .from("blacklisted_phone_numbers")
      .select("phone_number")
      .in("phone_number", allFormats)

    if (error) {
      console.error("[BLACKLIST] Error batch checking blacklist:", error)
      return new Set()
    }

    const blacklistedFormats = new Set(data?.map((r) => r.phone_number) ?? [])
    return new Set(
      phoneNumbers.filter((phone) =>
        getBlacklistFormats(phone).some((fmt) => blacklistedFormats.has(fmt))
      )
    )
  } catch (error) {
    console.error("[BLACKLIST] Error batch checking phones:", error)
    return new Set()
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
