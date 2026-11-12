import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { UUID_RE } from "@/lib/momo-claim/admin-validate"

// Send & Claim admin: payment sessions list and force-expire. Never log codes or user ids.
export const dynamic = "force-dynamic"

const TAG = "[MOMO-ADMIN-SESSIONS]"

const fail = (error: string, status: number) => NextResponse.json({ error }, { status })

type Db = NonNullable<typeof supabaseAdmin>
type Ctx = { db: Db; userId?: string }

function logError(where: string, err: unknown) {
  const e = (err && typeof err === "object" ? err : {}) as { code?: unknown }
  const code = typeof e.code === "string" ? e.code.replace(/[^A-Za-z0-9_]/g, "").slice(0, 20) : "-"
  console.error(`${TAG} ${where} failed code=${code}`)
}

async function gate(request: NextRequest, write: boolean): Promise<Ctx | NextResponse> {
  const auth = await verifyAdminAccess(request)
  if (auth.errorResponse) return auth.errorResponse
  if (!auth.isAdmin) return fail("Admin access required", 403)
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY || !supabaseAdmin) return fail("unavailable", 503)
  if (write && !auth.userId) return fail("admin_user_required", 403)
  return { db: supabaseAdmin, userId: auth.userId }
}
const isResponse = (x: Ctx | NextResponse): x is NextResponse => x instanceof Response

type Row = {
  id: string
  user_id: string
  code: string
  amount: number
  fee: number
  net_amount: number
  status: string
  created_at: string
  expires_at: string
  claimed_transaction_id: string | null
}

export async function GET(request: NextRequest) {
  const ctx = await gate(request, false)
  if (isResponse(ctx)) return ctx
  try {
    const { data, error } = await ctx.db
      .from("wallet_topup_sessions")
      .select("id, user_id, code, amount, fee, net_amount, status, created_at, expires_at, claimed_transaction_id")
      .order("created_at", { ascending: false })
      .limit(200)
    if (error) {
      logError("list", error)
      return fail("server_error", 500)
    }
    const now = Date.now()
    const sessions = ((data ?? []) as Row[]).map((r) => ({
      id: r.id,
      userId: r.user_id,
      code: r.code,
      amount: r.amount,
      fee: r.fee,
      netAmount: r.net_amount,
      status: r.status === "pending" && Date.parse(r.expires_at) <= now ? "expired" : r.status,
      createdAt: r.created_at,
      expiresAt: r.expires_at,
      claimedTransactionId: r.claimed_transaction_id,
    }))
    return NextResponse.json({ sessions })
  } catch (err) {
    logError("list", err)
    return fail("server_error", 500)
  }
}

export async function PATCH(request: NextRequest) {
  const ctx = await gate(request, true)
  if (isResponse(ctx)) return ctx

  let body: Record<string, unknown>
  try {
    const parsed = await request.json()
    body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  } catch {
    return fail("invalid_json", 400)
  }
  if (body.action !== "force_expire") return fail("invalid_action", 400)
  if (typeof body.id !== "string" || !UUID_RE.test(body.id)) return fail("invalid_id", 400)

  try {
    const { data, error } = await ctx.db
      .from("wallet_topup_sessions")
      .update({ status: "expired", force_expired_by: ctx.userId })
      .eq("id", body.id)
      .eq("status", "pending")
      .select("id")
    if (error) {
      logError("force-expire", error)
      return fail("server_error", 500)
    }
    if (!Array.isArray(data) || data.length === 0) return fail("invalid_state", 409)
    return NextResponse.json({ ok: true })
  } catch (err) {
    logError("force-expire", err)
    return fail("server_error", 500)
  }
}
