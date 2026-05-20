import { createClient } from "@supabase/supabase-js"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// Resolves a customer email for Paystack from a phone number.
// Tries to find an existing user account; falls back to a synthetic address.
export async function resolveEmail(msisdn: string): Promise<string> {
  // Normalise to local format for DB lookup (0XXXXXXXXX)
  const localPhone = msisdn.startsWith('+233')
    ? '0' + msisdn.slice(4)
    : msisdn.startsWith('233')
    ? '0' + msisdn.slice(3)
    : msisdn

  // Try the users table (phone_number column)
  const { data: user } = await supabase
    .from("users")
    .select("email")
    .eq("phone_number", localPhone)
    .maybeSingle()

  // Validate before using — a stored email with spaces or bad syntax will cause
  // Paystack to reject the charge with "Invalid email address".
  const emailOk = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim())
  if (user?.email && emailOk(user.email)) return user.email.trim()

  // Synthetic fallback — Paystack only needs a valid key for deduplication;
  // it never contacts this address.
  const digits = localPhone.replace(/\D/g, '')
  return `${digits}@ussd.datagod.com`
}
