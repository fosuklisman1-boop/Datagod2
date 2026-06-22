import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { applyRateLimit } from "@/lib/rate-limiter"

/**
 * GET  /api/auth/sessions                  (Authorization: Bearer <token>)
 *   → lists the caller's active auth sessions (device, IP, last active, current flag)
 *
 * POST /api/auth/sessions                   (Authorization: Bearer <token>)
 *   { action: "logout_others" }            → revoke every session except the current one
 *   { action: "revoke", sessionId }        → revoke one specific session (must be the caller's)
 *
 * Why a server route + RPC: `auth.sessions` lives in the `auth` schema, which
 * PostgREST does not expose, so the browser client cannot read it directly. The
 * underlying functions (get_user_sessions / revoke_*_user_session[s]) are
 * SECURITY DEFINER and have EXECUTE revoked from anon/authenticated — only the
 * service-role client (here, after we authenticate the caller) may invoke them,
 * and every call is scoped to the caller's own user id.
 */

function serviceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || "",
    process.env.SUPABASE_SERVICE_ROLE_KEY || "",
    { auth: { autoRefreshToken: false, persistSession: false } }
  )
}

/** The current access token carries a `session_id` claim — decode it so we can
 *  flag (and never revoke) the device making this request. */
function currentSessionId(token: string): string | null {
  try {
    const payload = token.split(".")[1]
    if (!payload) return null
    const json = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))
    return typeof json.session_id === "string" ? json.session_id : null
  } catch {
    return null
  }
}

/** Turn a raw User-Agent into a short, human-friendly device label. */
function deviceLabel(ua: string | null): string {
  if (!ua) return "Unknown device"
  if (ua === "node") return "Server / API script"
  if (/vercel/i.test(ua)) return "Vercel server"

  let os = "Unknown"
  if (/iPhone/i.test(ua)) os = "iPhone"
  else if (/iPad/i.test(ua)) os = "iPad"
  else if (/Android/i.test(ua)) os = "Android"
  else if (/Windows/i.test(ua)) os = "Windows"
  else if (/Macintosh|Mac OS/i.test(ua)) os = "Mac"
  else if (/Linux/i.test(ua)) os = "Linux"

  let browser = ""
  if (/Edg\//i.test(ua)) browser = "Edge"
  else if (/OPR\/|Opera/i.test(ua)) browser = "Opera"
  else if (/Chrome\//i.test(ua)) browser = "Chrome"
  else if (/Firefox\//i.test(ua)) browser = "Firefox"
  else if (/Safari\//i.test(ua)) browser = "Safari"

  if (os === "Unknown" && !browser) return "Unknown device"
  return browser ? `${os} · ${browser}` : os
}

function authToken(request: NextRequest): string | null {
  const header = request.headers.get("Authorization")
  if (!header?.startsWith("Bearer ")) return null
  return header.slice(7)
}

export async function GET(request: NextRequest) {
  const token = authToken(request)
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const supabase = serviceClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser(token)
  if (authError || !user) {
    return NextResponse.json({ error: "Invalid authentication" }, { status: 401 })
  }

  const { data, error } = await supabase.rpc("get_user_sessions", { p_uid: user.id })
  if (error) {
    console.error("[AUTH-SESSIONS] list error:", error.message)
    return NextResponse.json({ error: "Failed to load sessions" }, { status: 500 })
  }

  const current = currentSessionId(token)
  const sessions = (data || []).map((s: any) => ({
    id: s.id,
    device: deviceLabel(s.user_agent),
    ip: s.ip || null,
    lastActive: s.last_active,
    createdAt: s.created_at,
    current: s.id === current,
  }))

  return NextResponse.json({ sessions, count: sessions.length })
}

export async function POST(request: NextRequest) {
  // Revoking sessions is sensitive — throttle it per IP.
  const rl = await applyRateLimit(request, "session_revoke", 10, 60 * 60 * 1000)
  if (!rl.allowed) {
    return NextResponse.json({ error: "Too many attempts. Please try again later." }, { status: 429 })
  }

  const token = authToken(request)
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  let body: any
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 })
  }
  const action = body?.action

  const supabase = serviceClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser(token)
  if (authError || !user) {
    return NextResponse.json({ error: "Invalid authentication" }, { status: 401 })
  }

  if (action === "logout_others") {
    const keep = currentSessionId(token)
    const { data, error } = await supabase.rpc("revoke_other_user_sessions", {
      p_uid: user.id,
      p_keep: keep,
    })
    if (error) {
      console.error("[AUTH-SESSIONS] revoke others error:", error.message)
      return NextResponse.json({ error: "Failed to sign out other devices" }, { status: 500 })
    }
    return NextResponse.json({ success: true, revoked: data ?? 0 })
  }

  if (action === "revoke") {
    const sessionId = body?.sessionId
    if (!sessionId || typeof sessionId !== "string") {
      return NextResponse.json({ error: "sessionId is required" }, { status: 400 })
    }
    if (sessionId === currentSessionId(token)) {
      return NextResponse.json({ error: "Use logout to end your current session" }, { status: 400 })
    }
    // Scoped to the caller's own user id inside the function — a user can never
    // revoke another account's session even by guessing its id.
    const { data, error } = await supabase.rpc("revoke_user_session", {
      p_uid: user.id,
      p_session: sessionId,
    })
    if (error) {
      console.error("[AUTH-SESSIONS] revoke one error:", error.message)
      return NextResponse.json({ error: "Failed to sign out device" }, { status: 500 })
    }
    return NextResponse.json({ success: true, revoked: data ?? 0 })
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 })
}
