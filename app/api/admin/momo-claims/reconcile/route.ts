import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { notifyMomoAdmins } from "@/lib/admin-actions/momo-claim"
import { extractStatementTxids, findMissingClaims, splitSyntheticClaims, UnknownColumnError } from "@/lib/momo-claim/reconcile"

// Send & Claim statement reconciliation: every wallet credit made from a forwarded SMS in the period must appear in
// the admin's MTN statement. A claimed id missing from it means a forged SMS was credited. Never log ids or CSV text.
export const dynamic = "force-dynamic"

const TAG = "[MOMO-RECON]"
const MAX_CSV_CHARS = 5 * 1024 * 1024
const MAX_SPAN_DAYS = 62
const PAGE = 1000
const LIST_LIMIT = 20
const LIST_MISSING_CAP = 200
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

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

function dayMs(v: unknown): number | null {
  if (typeof v !== "string" || !DATE_RE.test(v)) return null
  const t = Date.parse(`${v}T00:00:00.000Z`)
  if (Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== v) return null
  return t
}

export async function POST(request: NextRequest) {
  const ctx = await gate(request, true)
  if (isResponse(ctx)) return ctx
  const { db, userId } = ctx

  let body: Record<string, unknown>
  try {
    const parsed = await request.json()
    body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  } catch {
    return fail("invalid_json", 400)
  }

  const { csv, column, periodStart, periodEnd } = body
  if (typeof csv !== "string" || csv.length === 0) return fail("invalid_csv", 400)
  if (csv.length > MAX_CSV_CHARS) return fail("csv_too_large", 413)
  if (typeof column !== "string" || column.trim().length === 0 || column.length > 200) return fail("invalid_column", 400)
  const startMs = dayMs(periodStart)
  const endMs = dayMs(periodEnd)
  if (startMs === null || endMs === null || startMs > endMs) return fail("invalid_period", 400)
  // Inclusive: both the start and end day count, so same-day is 1 day.
  if ((endMs - startMs) / 86_400_000 + 1 > MAX_SPAN_DAYS) return fail("period_too_long", 400)
  const start = periodStart as string
  const end = periodEnd as string

  let statementIds: string[]
  try {
    statementIds = extractStatementTxids(csv, column)
  } catch (err) {
    if (err instanceof UnknownColumnError) return fail("unknown_column", 400)
    logError("parse", err)
    return fail("invalid_csv", 400)
  }

  try {
    const claimed: { transactionId: string; claimedAt: string }[] = []
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await db
        .from("momo_transactions")
        .select("transaction_id, claimed_at")
        .eq("status", "claimed")
        .gte("claimed_at", `${start}T00:00:00.000Z`)
        .lte("claimed_at", `${end}T23:59:59.999Z`)
        .order("transaction_id", { ascending: true })
        .range(from, from + PAGE - 1)
      if (error) {
        logError("claimed", error)
        return fail("server_error", 500)
      }
      const rows = (data ?? []) as { transaction_id: string; claimed_at: string }[]
      for (const r of rows) claimed.push({ transactionId: r.transaction_id, claimedAt: r.claimed_at })
      if (rows.length < PAGE) break
    }

    // Synthetic ids (admin-credited unreadable SMS) can never be on a statement: count them, do not report them missing.
    const { checkable, syntheticClaimed } = splitSyntheticClaims(claimed)
    const missing = findMissingClaims(checkable, new Set(statementIds), { start, end })

    // Alert first: a failed audit-row insert must never swallow possible forged credits.
    if (missing.length > 0) await notifyMomoAdmins({ kind: "reconciliation_missing", reasons: [`${missing.length} missing`] })

    const { data: run, error: insErr } = await db
      .from("momo_reconciliation_runs")
      .insert({
        admin_id: userId,
        period_start: start,
        period_end: end,
        statement_txids: statementIds.length,
        claimed_checked: checkable.length,
        missing_txids: missing,
      })
      .select("id")
      .single()
    if (insErr || !run) {
      logError("insert", insErr)
      return NextResponse.json({ error: "run_not_saved", missing, syntheticClaimed }, { status: 500 })
    }

    return NextResponse.json({
      runId: (run as { id: string }).id,
      statementTxids: statementIds.length,
      claimedChecked: checkable.length,
      missing,
      syntheticClaimed,
    })
  } catch (err) {
    logError("reconcile", err)
    return fail("server_error", 500)
  }
}

export async function GET(request: NextRequest) {
  const ctx = await gate(request, false)
  if (isResponse(ctx)) return ctx
  try {
    const { data, error } = await ctx.db
      .from("momo_reconciliation_runs")
      .select("id, admin_id, period_start, period_end, statement_txids, claimed_checked, missing_txids, created_at")
      .order("created_at", { ascending: false })
      .limit(LIST_LIMIT)
    if (error) {
      logError("list", error)
      return fail("server_error", 500)
    }
    const runs = ((data ?? []) as { missing_txids?: string[] | null }[]).map((r) => {
      const all = Array.isArray(r.missing_txids) ? r.missing_txids : []
      return { ...r, missing_txids: all.slice(0, LIST_MISSING_CAP), missingCount: all.length }
    })
    return NextResponse.json({ runs })
  } catch (err) {
    logError("list", err)
    return fail("server_error", 500)
  }
}
