import { createClient } from "@supabase/supabase-js"
import { finalizeJoinIntent } from "@/lib/sub-agents/join"

/**
 * Decide where to send a user after an auth session has just been established
 * (email-confirmation link or OAuth callback), finalizing their profile if needed.
 *
 * Shared by `app/auth/callback/route.ts` (OAuth / PKCE `?code=`) and
 * `app/auth/confirm/route.ts` (email link `?token_hash=`) so both behave
 * identically:
 *  - storefront sub-agent join (only /auth/confirm, signup type, matching nonce) → finalizeJoinIntent's target
 *  - profile already has a phone  → go to `next` (onboarded)
 *  - no phone but user_metadata carries first/last/phone (email-confirm signup)
 *    → finalize via the service-role `/api/auth/signup` (re-checks phone OTP,
 *      creates wallet, welcome email), then go to `next`
 *  - otherwise (e.g. Google OAuth with no phone) → `/auth/complete-profile`
 */
export interface JoinConfirmation {
  /** Raw join nonce from the confirmation link, or null when the link carried none. */
  nonce: string | null
  /** The auth user's identity providers (undefined when unknown: finalize then refuses). */
  identities?: string[]
}

/** Join nonce candidates: `join` on the confirm URL itself, or inside the redirect URL carried in `rt` or `next`. */
function readJoinNonce(params: URLSearchParams): string | null {
  const direct = params.get("join")
  if (direct) return direct
  for (const key of ["rt", "next"]) {
    const raw = params.get(key)
    if (!raw) continue
    try {
      const nonce = new URL(raw, "https://placeholder.invalid").searchParams.get("join")
      if (nonce) return nonce
    } catch {
      // not a URL
    }
  }
  return null
}

/**
 * For `/auth/confirm` only. Non-null only for a signup confirmation (`type` signup, or email, which is what the
 * on-domain confirmation template sends); magic links, invites and email changes never finalize a join, and
 * `/auth/callback` (OAuth, PKCE) never calls this.
 */
export function joinConfirmationFrom(
  type: string | null,
  params: URLSearchParams,
  user: { identities?: { provider?: string }[] | null }
): JoinConfirmation | null {
  if (type !== "signup" && type !== "email") return null
  return {
    nonce: readJoinNonce(params),
    identities: Array.isArray(user.identities) ? user.identities.map((i) => String(i?.provider ?? "")) : undefined,
  }
}

export async function resolvePostAuthRedirect(opts: {
  origin: string
  userId: string
  email: string | undefined
  userMetadata: Record<string, any> | null | undefined
  accessToken: string | undefined
  next: string
  /** Passed only by /auth/confirm for a signup confirmation (see joinConfirmationFrom). */
  joinConfirmation?: JoinConfirmation | null
}): Promise<string> {
  const { origin, userId, email, userMetadata, accessToken, next, joinConfirmation } = opts
  const safeNext = next.startsWith("/") ? next : "/dashboard"

  const supabaseAdmin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )

  // Storefront sub-agent join first, and only from a signup confirmation link: its intent is finalized here, never
  // through /api/auth/signup, whose 30-minute phone-code window may have passed. finalizeJoinIntent checks the nonce.
  if (joinConfirmation) {
    try {
      const joined = await finalizeJoinIntent(supabaseAdmin, userId, {
        email,
        nonce: joinConfirmation.nonce,
        identities: joinConfirmation.identities,
      })
      if (joined) return joined.target
    } catch (e: any) {
      console.error("[AUTH] join finalize failed:", e?.code ?? "", e?.message ?? "")
      return "/dashboard?join=error"
    }
  }

  const { data: profile } = await supabaseAdmin
    .from("users")
    .select("phone_number")
    .eq("id", userId)
    .maybeSingle()

  if (profile?.phone_number) return safeNext

  const md = userMetadata || {}
  if (md.phone_number && accessToken) {
    try {
      const res = await fetch(`${origin}/api/auth/signup`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({
          email,
          firstName: md.first_name,
          lastName: md.last_name,
          phoneNumber: md.phone_number,
        }),
      })
      if (res.ok) return safeNext
      console.warn("[AUTH] profile finalize returned", res.status)
    } catch (e) {
      console.error("[AUTH] profile finalize error:", e)
    }
  }

  return "/auth/complete-profile"
}
