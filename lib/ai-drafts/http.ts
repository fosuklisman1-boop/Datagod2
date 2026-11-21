import { createClient, type SupabaseClient } from "@supabase/supabase-js"
import { NextResponse, type NextRequest } from "next/server"
import { applyRateLimit } from "@/lib/rate-limiter"
import type { ConfirmCaller } from "./confirm"
import type { AiDraft } from "./types"

// Shared plumbing for the /api/ai/drafts routes. The routes stay thin: authenticate, build the caller, call the lib.
// Nothing here logs names, phones, emails or user ids.

let cached: SupabaseClient | null = null
/** Service-role client. Ownership is enforced inside lib/ai-drafts by user_id filters. */
export function draftsDb(): SupabaseClient {
  if (!cached) cached = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
  return cached
}

// Never derive from the Host header (attacker-controlled; the JWT is forwarded to this URL).
function getBaseUrl(): string {
  if (process.env.NEXT_PUBLIC_APP_URL) return process.env.NEXT_PUBLIC_APP_URL.replace(/\/$/, "")
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`
  return "http://localhost:3000"
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const isUuid = (s: string): boolean => UUID_RE.test(s)

export const notFound = () => NextResponse.json({ error: "Not found" }, { status: 404 })

export type AuthResult = { ok: true; db: SupabaseClient; caller: ConfirmCaller } | { ok: false; res: NextResponse }

/** Bearer JWT -> user id (only from auth.getUser), admin flag from a fresh users.role read. Fails closed. */
export async function authenticate(req: NextRequest): Promise<AuthResult> {
  const unauthorized = { ok: false as const, res: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) }
  const header = req.headers.get("authorization") ?? ""
  const m = /^Bearer\s+(\S+)$/i.exec(header)
  if (!m) return unauthorized
  const jwt = m[1]

  const db = draftsDb()
  let userId: string | undefined
  try {
    const { data, error } = await db.auth.getUser(jwt)
    if (error || !data?.user?.id) return unauthorized
    userId = data.user.id
  } catch {
    return unauthorized
  }

  const unavailable = { ok: false as const, res: NextResponse.json({ error: "Service unavailable" }, { status: 503 }) }
  let isAdmin = false
  try {
    const { data: row, error: roleError } = await db.from("users").select("role").eq("id", userId).maybeSingle()
    if (roleError) return unavailable
    isAdmin = (row as { role?: string } | null)?.role === "admin"
  } catch {
    console.error("ai_drafts: role read threw")
    return unavailable
  }

  return { ok: true, db, caller: { userId, isAdmin, jwt, baseUrl: getBaseUrl() } }
}

/** 10 requests / 60 s per user. Returns a 429 response when over the limit. */
export async function limitOrNull(req: NextRequest, endpoint: string, userId: string): Promise<NextResponse | null> {
  const rl = await applyRateLimit(req, endpoint, 10, 60_000, userId)
  return rl.allowed ? null : NextResponse.json({ error: "Too many requests. Please wait a moment." }, { status: 429 })
}

/** The stored state of a draft as the card reads it on a plain GET (succeeded/partial keep their own status). */
export function storedState(d: AiDraft) {
  // expires_at lets a card opened from a notification link (no prepare-time payload) show its real countdown.
  return { status: d.status, outcome: d.outcome, display: d.display, expires_at: d.expires_at }
}
