import { SupabaseClient } from "@supabase/supabase-js"

interface PhoneVerifyResult {
  allowed: boolean
  error?: string
}

/**
 * Server-side guard used by order/withdrawal routes.
 * Allows through during the 2-day grace period; blocks after deadline passes.
 */
export async function checkPhoneVerified(
  supabaseAdmin: SupabaseClient,
  userId: string
): Promise<PhoneVerifyResult> {
  const { data, error } = await supabaseAdmin
    .from("users")
    .select("phone_verified, phone_verify_deadline")
    .eq("id", userId)
    .single()

  if (error || !data) {
    // Can't determine status — allow through rather than blocking on a DB error
    return { allowed: true }
  }

  if (data.phone_verified) {
    return { allowed: true }
  }

  // Within grace period — don't block yet
  if (data.phone_verify_deadline && new Date(data.phone_verify_deadline) > new Date()) {
    return { allowed: true }
  }

  return {
    allowed: false,
    error: "Please verify your phone number to continue. Visit your dashboard to complete verification.",
  }
}
