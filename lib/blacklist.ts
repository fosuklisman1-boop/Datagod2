import { createClient } from "@supabase/supabase-js"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

/**
 * Check if a phone number is blacklisted
 */
export async function isPhoneBlacklisted(phoneNumber: string): Promise<boolean> {
  try {
    const { data, error } = await supabase
      .from("blacklisted_phone_numbers")
      .select("id")
      .eq("phone_number", phoneNumber)
      .single()

    if (error && error.code !== "PGRST116") {
      // PGRST116 = no rows found (expected)
      console.error("[BLACKLIST] Error checking blacklist:", error)
      return false
    }

    return !!data
  } catch (error) {
    console.error("[BLACKLIST] Error checking phone:", error)
    return false
  }
}

/**
 * Get blacklist entry for a phone number
 */
export async function getBlacklistEntry(phoneNumber: string) {
  try {
    const { data, error } = await supabase
      .from("blacklisted_phone_numbers")
      .select("*")
      .eq("phone_number", phoneNumber)
      .single()

    if (error && error.code !== "PGRST116") {
      console.error("[BLACKLIST] Error fetching entry:", error)
      return null
    }

    return data
  } catch (error) {
    console.error("[BLACKLIST] Error:", error)
    return null
  }
}
