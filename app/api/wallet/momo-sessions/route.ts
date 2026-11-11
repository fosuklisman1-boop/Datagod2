import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { applyRateLimit } from "@/lib/rate-limiter"
import { generateClaimCode } from "@/lib/momo-claim/codes"
import { computeFee, checkSessionAmount } from "@/lib/momo-claim/money"
import { WINDOW_MINUTES, MAX_OPEN_SESSIONS, nextSlotFreeAt } from "@/lib/momo-claim/window"
import { loadMomoClaimSettings, isStrictlyPhoneVerified } from "@/lib/momo-claim/settings"

// Send & Claim customer API: get a payment code (POST), list own codes + settings (GET), cancel (DELETE).
// Fee and net are computed server-side only. Never log codes, amounts, or phone numbers.
export const dynamic = "force-dynamic"

const TAG = "[MOMO-SESSIONS]"
const MAX_CODE_ATTEMPTS = 5
const PER_MINUTE_CAP = 5
const DAY_MS = 24 * 60 * 60 * 1000

const fail = (error: string, status: number, extra: Record<string, unknown> = {}) =>
  NextResponse.json({ error, ...extra }, { status })

type Db = NonNullable<typeof supabaseAdmin>
type Ctx = { db: Db; userId: string }
type Failure = NextResponse

/** 401 / 503 gate shared by every method. */
async function authenticate(request: NextRequest): Promise<Ctx | Failure> {
  const header = request.headers.get("authorization")
  if (!header?.startsWith("Bearer ")) return fail("unauthorized", 401)
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY || !supabaseAdmin) return fail("unavailable", 503)
  const token = header.slice(7)
  try {
    const { data, error } = await supabaseAdmin.auth.getUser(token)
    if (error || !data?.user) return fail("unauthorized", 401)
    return { db: supabaseAdmin, userId: data.user.id }
  } catch {
    return fail("unauthorized", 401)
  }
}

const isFailure = (x: Ctx | Failure): x is Failure => x instanceof Response

function logError(where: string, err: unknown) {
  const e = (err && typeof err === "object" ? err : {}) as { code?: unknown }
  const code = typeof e.code === "string" ? e.code.replace(/[^A-Za-z0-9_]/g, "").slice(0, 20) : "-"
  console.error(`${TAG} ${where} failed code=${code}`)
}

async function feePercentFor(db: Db, userId: string, s: { feeCustomerPercent: number; feeDealerPercent: number }) {
  const { data } = await db.from("users").select("role").eq("id", userId).maybeSingle()
  return (data as { role?: string } | null)?.role === "dealer" ? s.feeDealerPercent : s.feeCustomerPercent
}

type Row = {
  id: string
  code: string
  amount: number
  fee: number
  net_amount: number
  status: string
  created_at: string
  expires_at: string
}

function mapRow(r: Row, now: number) {
  const expired = r.status === "pending" && new Date(r.expires_at).getTime() <= now
  return {
    id: r.id,
    code: r.code,
    amount: Number(r.amount),
    fee: Number(r.fee),
    netAmount: Number(r.net_amount),
    status: expired ? "expired" : r.status,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
  }
}

/** GHS number with at most 2 decimals, > 0 -> pesewas; null otherwise. */
function toPesewas(x: unknown): number | null {
  if (typeof x !== "number" || !Number.isFinite(x) || x <= 0) return null
  const p = Math.round(x * 100)
  if (p <= 0 || Math.abs(x * 100 - p) > 1e-6) return null
  return p
}

export async function GET(request: NextRequest) {
  const ctx = await authenticate(request)
  if (isFailure(ctx)) return ctx
  const { db, userId } = ctx
  try {
    const s = await loadMomoClaimSettings(db)
    if (!s.enabled) return NextResponse.json({ enabled: false })

    const now = Date.now()
    const feePercent = await feePercentFor(db, userId, s)
    const { data, error } = await db
      .from("wallet_topup_sessions")
      .select("id, code, amount, fee, net_amount, status, created_at, expires_at")
      .eq("user_id", userId)
      .gte("created_at", new Date(now - DAY_MS).toISOString())
      .order("created_at", { ascending: false })
    if (error) throw error

    return NextResponse.json({
      enabled: true,
      accounts: s.accounts,
      accountName: s.accountName,
      feePercent,
      minNet: s.minNetPesewas / 100,
      maxSent: s.maxSentPesewas / 100,
      sessions: ((data ?? []) as Row[]).map((r) => mapRow(r, now)),
    })
  } catch (err) {
    logError("GET", err)
    return fail("server_error", 500)
  }
}

export async function POST(request: NextRequest) {
  const ctx = await authenticate(request)
  if (isFailure(ctx)) return ctx
  const { db, userId } = ctx

  try {
    const s = await loadMomoClaimSettings(db)
    if (!s.enabled) return fail("feature_off", 403)

    const limit = await applyRateLimit(request, "momo-sessions", PER_MINUTE_CAP, 60_000, userId)
    if (!limit.allowed) return fail("rate_limited", 429)

    if (!(await isStrictlyPhoneVerified(db, userId))) return fail("phone_not_verified", 403)

    const { data: wallet, error: walletErr } = await db.from("wallets").select("user_id").eq("user_id", userId).maybeSingle()
    if (walletErr) throw walletErr
    if (!wallet) return fail("no_wallet", 403)

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return fail("invalid", 400)
    }
    const amount = body && typeof body === "object" ? (body as { amount?: unknown }).amount : undefined
    const sentPesewas = toPesewas(amount)
    if (sentPesewas === null) return fail("invalid", 400)

    const feePercent = await feePercentFor(db, userId, s)
    const verdict = checkSessionAmount(sentPesewas, feePercent, s.minNetPesewas, s.maxSentPesewas)
    if (verdict !== "ok") return fail(verdict, 400)
    const { feePesewas, netPesewas } = computeFee(sentPesewas, feePercent)

    const now = new Date()

    // DB-backed burst cap: the limiter above fails open when Redis is down.
    const { count: recent, error: recentErr } = await db
      .from("wallet_topup_sessions")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .gte("created_at", new Date(now.getTime() - 60_000).toISOString())
    if (recentErr) throw recentErr
    if ((recent ?? 0) >= PER_MINUTE_CAP) return fail("rate_limited", 429)

    const { data: open, error: openErr } = await db
      .from("wallet_topup_sessions")
      .select("id, status, created_at, expires_at")
      .eq("user_id", userId)
      .eq("status", "pending")
      .gt("expires_at", now.toISOString())
    if (openErr) throw openErr
    const lite = ((open ?? []) as { id: string; status: string; created_at: string; expires_at: string }[]).map((r) => ({
      id: r.id,
      status: r.status,
      createdAt: r.created_at,
      expiresAt: r.expires_at,
    }))
    if (lite.length >= MAX_OPEN_SESSIONS) {
      const free = nextSlotFreeAt(lite, now)
      return fail("too_many_open", 409, { nextSlotFreeAt: free ? free.toISOString() : null })
    }

    const expiresAt = new Date(now.getTime() + WINDOW_MINUTES * 60_000).toISOString()
    for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt++) {
      const { data: row, error } = await db
        .from("wallet_topup_sessions")
        .insert({
          user_id: userId,
          code: generateClaimCode(),
          amount: sentPesewas / 100,
          fee: feePesewas / 100,
          net_amount: netPesewas / 100,
          status: "pending",
          expires_at: expiresAt,
        })
        .select("id, code, amount, fee, net_amount, status, created_at, expires_at")
        .single()
      if (!error && row) {
        const r = row as Row
        return NextResponse.json({ session: mapRow({ ...r, created_at: r.created_at ?? now.toISOString() }, now.getTime()) }, { status: 201 })
      }
      if ((error as { code?: string } | null)?.code !== "23505") throw error ?? new Error("insert failed")
    }
    return fail("unavailable", 503)
  } catch (err) {
    logError("POST", err)
    return fail("server_error", 500)
  }
}

export async function DELETE(request: NextRequest) {
  const ctx = await authenticate(request)
  if (isFailure(ctx)) return ctx
  const { db, userId } = ctx

  const id = new URL(request.url).searchParams.get("id")
  if (!id) return fail("invalid", 400)
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return fail("not_found", 404)

  try {
    const { data, error } = await db
      .from("wallet_topup_sessions")
      .update({ status: "cancelled" })
      .eq("id", id)
      .eq("user_id", userId)
      .eq("status", "pending")
      .select("id")
    if (error) throw error
    if (!data || data.length === 0) return fail("not_found", 404)
    return NextResponse.json({ ok: true })
  } catch (err) {
    logError("DELETE", err)
    return fail("server_error", 500)
  }
}
