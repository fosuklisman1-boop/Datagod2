import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { applyRateLimit } from "@/lib/rate-limiter"
import { loadMomoClaimSettings } from "@/lib/momo-claim/settings"

// Send & Claim manual claim: the customer types the MoMo Transaction ID; the SQL function
// claim_momo_via_session does all matching, crediting and DB-backed attempt limits.
// This route only authenticates, validates shape, and maps results to fixed copy.
// Never log the transaction id, session id or user id.
export const dynamic = "force-dynamic"

const TAG = "[MOMO-CLAIM]"
const PER_WINDOW_CAP = 3
const WINDOW_MS = 30_000
const TXID_RE = /^[0-9]{8,15}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const COPY = {
  credited: "Payment found. Your wallet has been credited.",
  under_review: "We found your payment. It is being checked and will be credited shortly.",
  already_credited: "This payment has already been credited to your wallet.",
  not_matched: "We couldn't match this Transaction ID to your payment. Check the ID and try again.",
  no_session: "Start a payment first, then enter your Transaction ID.",
  rate_limited: "Too many attempts. Please wait a moment and try again.",
  daily_limit: "Too many attempts today. Please contact support.",
} as const
type ClaimResult = keyof typeof COPY

const reply = (result: ClaimResult) => NextResponse.json({ result, message: COPY[result] })
const fail = (error: string, status: number) => NextResponse.json({ error }, { status })

function logError(err: unknown) {
  const e = (err && typeof err === "object" ? err : {}) as { code?: unknown }
  const code = typeof e.code === "string" ? e.code.replace(/[^A-Za-z0-9_]/g, "").slice(0, 20) : "-"
  console.error(`${TAG} rpc failed code=${code}`)
}

export async function POST(request: NextRequest) {
  const header = request.headers.get("authorization")
  if (!header?.startsWith("Bearer ")) return fail("unauthorized", 401)
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY || !supabaseAdmin) return fail("unavailable", 503)
  const db = supabaseAdmin

  let userId: string
  try {
    const { data, error } = await db.auth.getUser(header.slice(7))
    if (error || !data?.user) return fail("unauthorized", 401)
    userId = data.user.id
  } catch {
    return fail("unauthorized", 401)
  }

  const settings = await loadMomoClaimSettings(db)
  if (!settings.enabled) return fail("feature_off", 403)

  // Fails open when Redis is down; the RPC's DB-backed limits are the real guard.
  const limit = await applyRateLimit(request, "momo-claim", PER_WINDOW_CAP, WINDOW_MS, userId)
  if (!limit.allowed) return NextResponse.json({ result: "rate_limited", message: COPY.rate_limited }, { status: 429 })

  let body: unknown = null
  try {
    body = await request.json()
  } catch {
    // fall through: treated as an unmatchable id
  }
  const b = (body && typeof body === "object" ? body : {}) as { transactionId?: unknown; sessionId?: unknown }
  const txid = typeof b.transactionId === "string" ? b.transactionId.trim() : ""
  if (!TXID_RE.test(txid)) return reply("not_matched")
  const sessionId = typeof b.sessionId === "string" && UUID_RE.test(b.sessionId) ? b.sessionId : null

  try {
    const { data, error } = await db.rpc("claim_momo_via_session", {
      p_user: userId,
      p_txid: txid,
      p_session_id: sessionId,
    })
    if (error) {
      logError(error)
      return reply("not_matched")
    }
    return reply(typeof data === "string" && Object.hasOwn(COPY, data) ? (data as ClaimResult) : "not_matched")
  } catch (err) {
    logError(err)
    return reply("not_matched")
  }
}
