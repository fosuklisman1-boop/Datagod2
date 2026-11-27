import { createClient, type SupabaseClient } from "@supabase/supabase-js"
import { randomBytes } from "node:crypto"

export type Session = { access_token: string; refresh_token: string; expires_at?: number }

export interface SessionDeps {
  /** Fresh, non-persisting anon client on every call. */
  anon: () => SupabaseClient
  /** Service-role client. */
  admin: SupabaseClient
}

const DUMMY_EMAIL = "no-such-user@invalid.datagod"

const AUTH_OPTS = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } }

function toSession(s: { access_token: string; refresh_token: string; expires_at?: number }): Session {
  return { access_token: s.access_token, refresh_token: s.refresh_token, expires_at: s.expires_at }
}

/** GoTrue answers a wrong password with code `invalid_credentials` (older servers: only the message). */
function isWrongPassword(error: { code?: string; message?: string }): boolean {
  if (error.code === "invalid_credentials" || error.code === "email_not_confirmed") return true
  return !error.code && /invalid login credentials/i.test(error.message ?? "")
}

/**
 * Verifies a password. Returns null ONLY for a real wrong password. Any other failure (rate limit, 5xx,
 * captcha, network) THROWS so the caller answers 503 and never counts it against the user's lockout.
 */
export async function verifyPassword(d: SessionDeps, email: string, password: string): Promise<Session | null> {
  const { data, error } = await d.anon().auth.signInWithPassword({ email, password })
  if (error) {
    if (isWrongPassword(error)) return null
    throw new Error("password check unavailable")
  }
  if (!data?.session) throw new Error("password check unavailable")
  return toSession(data.session)
}

/** Timing equalizer for unknown numbers. Result is ignored; never throws. */
export async function dummyPasswordCheck(d: SessionDeps): Promise<void> {
  try {
    await d.anon().auth.signInWithPassword({
      email: DUMMY_EMAIL,
      password: randomBytes(24).toString("hex"),
    })
  } catch {
    /* swallow */
  }
}

/**
 * Revokes only this session. Scope MUST stay 'local': the default 'global'
 * would sign the real owner out of every device.
 */
export async function revokeSessionLocal(d: SessionDeps, accessToken: string): Promise<void> {
  const { error } = await d.admin.auth.admin.signOut(accessToken, "local")
  if (error) throw new Error("session revoke failed")
}

/** Mints a session without sending any email (generateLink + verifyOtp). */
export async function mintSession(d: SessionDeps, email: string): Promise<Session> {
  const { data: link, error: linkErr } = await d.admin.auth.admin.generateLink({ type: "magiclink", email })
  const tokenHash = link?.properties?.hashed_token
  if (linkErr || !tokenHash) throw new Error("session mint failed")
  const { data, error } = await d.anon().auth.verifyOtp({ type: "magiclink", token_hash: tokenHash })
  if (error || !data?.session) throw new Error("session mint failed")
  return toSession(data.session)
}

export function defaultSessionDeps(): SessionDeps {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || ""
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ""
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || ""
  return {
    anon: () => createClient(url, anonKey, AUTH_OPTS),
    admin: createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } }),
  }
}
