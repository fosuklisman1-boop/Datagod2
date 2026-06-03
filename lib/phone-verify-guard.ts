import { SupabaseClient } from "@supabase/supabase-js"
import { isPhoneGateDisabled } from "@/lib/storefront-otp"

interface PhoneVerifyResult {
  allowed: boolean
  error?: string
}

interface PhoneGuardOptions {
  /**
   * When the user's status can't be read (DB error), what do we do?
   *   - true  (default): block. Use for money-moving routes — a read blip must
   *     not silently drop the gate during an attack.
   *   - false: allow. Only for non-sensitive callers that explicitly opt in.
   */
  failClosed?: boolean
}

/**
 * Server-side guard used by order/withdrawal/charge routes. Allows through when
 * phone is verified, during the grace period, or while the admin kill switch is
 * on. Fails CLOSED by default so a transient error can't be used to bypass it.
 *
 * NOTE: this is one of two enforcement layers. The DB trigger in
 * migrations/0055_phone_gate_db_enforcement.sql is the un-skippable backstop for
 * writes (e.g. the client-side withdrawal_requests insert) that never pass
 * through an API route. Keep the two in sync — same logic, both fail closed.
 */
export async function checkPhoneVerified(
  supabaseAdmin: SupabaseClient,
  userId: string,
  options: PhoneGuardOptions = {}
): Promise<PhoneVerifyResult> {
  const failClosed = options.failClosed ?? true

  // Emergency kill switch: an admin can disable the whole gate (no deploy) if OTP
  // delivery fails and users get locked out. Same flag the UI modal reads.
  try {
    if (await isPhoneGateDisabled()) {
      return { allowed: true }
    }
  } catch {
    // Kill-switch read failed — fall through to the normal check (which itself
    // fails closed). Better to enforce than to accidentally open the gate.
  }

  const { data, error } = await supabaseAdmin
    .from("users")
    .select("phone_verified, phone_verify_deadline")
    .eq("id", userId)
    .single()

  if (error || !data) {
    if (failClosed) {
      return {
        allowed: false,
        error: "Could not verify your phone status. Please try again in a moment.",
      }
    }
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
