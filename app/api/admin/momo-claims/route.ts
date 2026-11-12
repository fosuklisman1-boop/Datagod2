import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { loadMomoClaimSettings } from "@/lib/momo-claim/settings"
import { validateSettings, hasAtMostTwoDecimals, UUID_RE } from "@/lib/momo-claim/admin-validate"
import { notifyMomoAdmins } from "@/lib/admin-actions/momo-claim"

// Send & Claim admin API: monitor forwarded MoMo SMS rows, void/restore/unflag, credit or assign a flagged
// payment, and edit settings. Never log transaction ids, phone numbers, names or raw SMS.
export const dynamic = "force-dynamic"

const TAG = "[MOMO-ADMIN]"
const STATUSES = ["pending", "claimed", "flagged", "voided", "unparsed", "rejected_sender"] as const
const LIST_COLUMNS =
  "id, transaction_id, network, pattern, amount, sender_name, sms_sender, sms_balance, status, flag_reasons, session_id, claimed_by, claimed_at, fee, net_amount, credited_by_admin, admin_reason, unflagged_by, unflagged_at, unflag_reason, received_at"
const SUSPICIOUS_ATTEMPTS = 5

const fail = (error: string, status: number, extra: Record<string, unknown> = {}) =>
  NextResponse.json({ error, ...extra }, { status })

type Db = NonNullable<typeof supabaseAdmin>
type Ctx = { db: Db; userId?: string }

function logError(where: string, err: unknown) {
  const e = (err && typeof err === "object" ? err : {}) as { code?: unknown }
  const code = typeof e.code === "string" ? e.code.replace(/[^A-Za-z0-9_]/g, "").slice(0, 20) : "-"
  console.error(`${TAG} ${where} failed code=${code}`)
}

/** Admin gate shared by every method. Writes also need a real admin user id (the cron bypass has none). */
async function gate(request: NextRequest, write: boolean): Promise<Ctx | NextResponse> {
  const auth = await verifyAdminAccess(request)
  if (auth.errorResponse) return auth.errorResponse
  if (!auth.isAdmin) return fail("Admin access required", 403)
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY || !supabaseAdmin) return fail("unavailable", 503)
  if (write && !auth.userId) return fail("admin_user_required", 403)
  return { db: supabaseAdmin, userId: auth.userId }
}
const isResponse = (x: Ctx | NextResponse): x is NextResponse => x instanceof Response

function isoOrNull(v: string | null, endOfDay: boolean): string | null {
  if (!v) return null
  const s = /^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}${endOfDay ? "T23:59:59.999Z" : "T00:00:00.000Z"}` : v
  const t = Date.parse(s)
  return Number.isNaN(t) ? null : new Date(t).toISOString()
}

export async function GET(request: NextRequest) {
  const params = new URL(request.url).searchParams
  // Raw SMS holds names and numbers: only a real admin user (not the cron bypass) may open it.
  const ctx = await gate(request, Boolean(params.get("raw")))
  if (isResponse(ctx)) return ctx
  const { db } = ctx

  try {
    const raw = params.get("raw")
    if (raw) {
      const { data, error } = await db.from("momo_transactions").select("raw_sms").eq("transaction_id", raw).maybeSingle()
      if (error) {
        logError("raw", error)
        return fail("server_error", 500)
      }
      if (!data) return fail("not_found", 404)
      return NextResponse.json({ rawSms: (data as { raw_sms: string }).raw_sms })
    }

    let list = db.from("momo_transactions").select(LIST_COLUMNS)
    const status = params.get("status")
    if (status && (STATUSES as readonly string[]).includes(status)) list = list.eq("status", status)
    const network = params.get("network")
    if (network && network.length <= 20) list = list.eq("network", network)
    const from = isoOrNull(params.get("from"), false)
    if (from) list = list.gte("received_at", from)
    const to = isoOrNull(params.get("to"), true)
    if (to) list = list.lte("received_at", to)
    const q = (params.get("q") ?? "").replace(/[^A-Za-z0-9 _.@-]/g, "").trim().slice(0, 60)
    if (q) {
      const parts = [`transaction_id.ilike.%${q}%`, `sender_name.ilike.%${q}%`]
      if (UUID_RE.test(q)) parts.push(`claimed_by.eq.${q}`)
      list = list.or(parts.join(","))
    }
    list = list.order("received_at", { ascending: false }).limit(200)

    const [listRes, suspiciousRes, settings, ...countRes] = await Promise.all([
      list,
      db.rpc("momo_suspicious_claimers", { p_min_attempts: SUSPICIOUS_ATTEMPTS, p_limit: 100 }),
      loadMomoClaimSettings(db),
      ...STATUSES.map((s) => db.from("momo_transactions").select("id", { count: "exact", head: true }).eq("status", s)),
    ])
    const firstError = listRes.error ?? suspiciousRes.error ?? countRes.find((c) => c.error)?.error
    if (firstError) {
      logError("get", firstError)
      return fail("server_error", 500)
    }

    const counts: Record<string, number> = {}
    STATUSES.forEach((s, i) => {
      counts[s] = countRes[i]?.count ?? 0
    })

    const suspicious = ((suspiciousRes.data ?? []) as { user_id: string; attempts: number | string }[]).map((r) => ({
      userId: r.user_id,
      attempts: Number(r.attempts),
    }))

    return NextResponse.json({
      settingsDefaulted: settings.source === "defaults",
      transactions: listRes.data ?? [],
      counts,
      suspicious,
      settings: {
        enabled: settings.enabled,
        accounts: settings.accounts,
        accountName: settings.accountName,
        feeCustomerPercent: settings.feeCustomerPercent,
        feeDealerPercent: settings.feeDealerPercent,
        minNet: settings.minNetPesewas / 100,
        maxSent: settings.maxSentPesewas / 100,
        senderAllowlist: settings.senderAllowlist,
        regressionThreshold: settings.regressionThreshold,
        reviewThreshold: settings.reviewThresholdPesewas / 100,
        dailyCap: settings.dailyCapPesewas / 100,
        firstClaimReview: settings.firstClaimReview,
      },
    })
  } catch (err) {
    logError("get", err)
    return fail("server_error", 500)
  }
}

export async function POST(request: NextRequest) {
  const ctx = await gate(request, true)
  if (isResponse(ctx)) return ctx
  const { db, userId } = ctx

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return fail("invalid_json", 400)
  }
  const v = validateSettings(body)
  if (!v.ok) return fail(v.error ?? "invalid_setting", 400, { field: v.field })
  const s = v.value

  // A whole-form save after a failed load would write the fallback values over the real ones.
  const current = await loadMomoClaimSettings(db)
  if (current.source === "defaults") return fail("settings_unavailable", 409)
  // Optional in the body: absent keeps what is saved now.
  const firstClaimReview = s.firstClaimReview ?? current.firstClaimReview

  const now = new Date().toISOString()
  const entries: [string, unknown][] = [
    ["momo_claim_enabled", s.enabled],
    ["momo_payment_accounts", s.accounts],
    ["momo_account_name", s.accountName],
    ["momo_claim_fee_customer", s.feeCustomerPercent],
    ["momo_claim_fee_dealer", s.feeDealerPercent],
    ["momo_min_claimable", s.minNet],
    ["momo_max_claimable", s.maxSent],
    ["momo_sms_sender_allowlist", s.senderAllowlist],
    ["momo_txid_regression_threshold", s.regressionThreshold],
    ["momo_auto_claim_review_threshold", s.reviewThreshold],
    ["momo_auto_claim_daily_cap", s.dailyCap],
    ["momo_first_claim_review", firstClaimReview],
  ]
  const rows = entries.map(([key, value]) => ({ key, value: { value }, updated_by: userId, updated_at: now }))
  try {
    const { error } = await db.from("admin_settings").upsert(rows, { onConflict: "key" })
    if (error) {
      logError("settings", error)
      return fail("save_failed", 500)
    }
    if (firstClaimReview !== current.firstClaimReview) await alertReviewToggle(firstClaimReview)
    return NextResponse.json({ ok: true })
  } catch (err) {
    logError("settings", err)
    return fail("save_failed", 500)
  }
}

/** Admin alert when first-claim review is switched. No PII. Never throws, never changes the response. */
async function alertReviewToggle(on: boolean): Promise<void> {
  try {
    await notifyMomoAdmins({ kind: "setting_changed", reasons: [on ? "first-claim review turned ON" : "first-claim review turned OFF"] })
  } catch {
    // notifyMomoAdmins never throws; belt and braces
  }
}

function cleanReason(x: unknown): string | null {
  if (typeof x !== "string") return null
  const t = x.trim()
  return t.length >= 1 && t.length <= 200 ? t : null
}

/** Map a raise from the SQL functions to a short, safe response. Never returns raw error text. */
function mapRaise(err: unknown, fallback: string): NextResponse {
  const msg = err && typeof err === "object" ? String((err as { message?: unknown }).message ?? "") : ""
  const token = msg.trim().split(/[\s:]/)[0]
  switch (token) {
    case "BAD_INPUT":
      return fail("bad_input", 400)
    case "NO_WALLET":
      return fail("no_wallet", 400)
    case "NOT_FOUND":
      return fail("not_found", 404)
    case "BAD_STATE":
      return fail("invalid_state", 409)
    case "CONFLICT":
      return fail("conflict", 409)
    case "BAD_SETTING":
      return fail("bad_setting", 409)
    default:
      logError("rpc", err)
      return fail(fallback, 500)
  }
}

async function callRpc(
  db: Db,
  fn: string,
  args: Record<string, unknown>,
  ok: string[],
  onOk?: (result: string) => Promise<void>,
): Promise<NextResponse> {
  const failCode = fn === "admin_credit_momo_transaction" ? "credit_failed" : "unflag_failed"
  try {
    const { data, error } = await db.rpc(fn, args)
    if (error) return mapRaise(error, failCode)
    if (typeof data === "string" && ok.includes(data)) {
      // onOk must never throw (alertAdminCredit swallows everything): the money already moved.
      if (onOk) await onOk(data).catch(() => undefined)
      return NextResponse.json({ result: data })
    }
    logError("rpc-result", null)
    return fail(failCode, 500)
  } catch (err) {
    logError("rpc", err)
    return fail(failCode, 500)
  }
}

async function transition(db: Db, txid: string, to: string, from: string[], result: string): Promise<NextResponse> {
  try {
    const q = db.from("momo_transactions").update({ status: to })
    const { data, error } = await (from.length === 1 ? q.eq("transaction_id", txid).eq("status", from[0]) : q.eq("transaction_id", txid).in("status", from)).select("id")
    if (error) {
      logError(result, error)
      return fail("server_error", 500)
    }
    if (!Array.isArray(data) || data.length === 0) return fail("invalid_state", 409)
    return NextResponse.json({ result })
  } catch (err) {
    logError(result, err)
    return fail("server_error", 500)
  }
}

const ACTIONS = ["void", "restore", "unflag", "credit", "assign"] as const

export async function PATCH(request: NextRequest) {
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
  const action = body.action
  if (typeof action !== "string" || !(ACTIONS as readonly string[]).includes(action)) return fail("invalid_action", 400)
  const txid = body.transactionId
  if (typeof txid !== "string" || txid.length < 1 || txid.length > 60) return fail("invalid_transaction", 400)

  if (action === "void") return transition(db, txid, "voided", ["pending", "unparsed"], "voided")
  if (action === "restore") return transition(db, txid, "pending", ["voided"], "restored")

  const reason = cleanReason(body.reason)
  if (!reason) return fail("reason_required", 400)

  if (action === "unflag") {
    return callRpc(db, "admin_unflag_momo_transaction", { p_txid: txid, p_admin: userId, p_reason: reason }, ["unflagged"])
  }

  let target: string
  let amount: number | null = null

  try {
    if (action === "credit") {
      const { data: tx, error: txErr } = await db.from("momo_transactions").select("session_id").eq("transaction_id", txid).maybeSingle()
      if (txErr) {
        logError("credit-lookup", txErr)
        return fail("credit_failed", 500)
      }
      if (!tx) return fail("not_found", 404)
      const sid = (tx as { session_id: string | null }).session_id
      if (!sid) return fail("no_linked_session", 409)
      const { data: sess, error: sessErr } = await db.from("wallet_topup_sessions").select("user_id").eq("id", sid).maybeSingle()
      if (sessErr) {
        logError("credit-session", sessErr)
        return fail("credit_failed", 500)
      }
      const uid = (sess as { user_id?: string } | null)?.user_id
      if (!uid) return fail("no_linked_session", 409)
      target = uid
    } else {
      const t = body.targetUserId
      if (typeof t !== "string" || !UUID_RE.test(t)) return fail("unknown_user", 400)
      const a = body.amount
      if (a !== undefined && a !== null) {
        if (typeof a !== "number" || !Number.isFinite(a) || a <= 0 || a >= 1000000 || !hasAtMostTwoDecimals(a)) {
          return fail("invalid_amount", 400)
        }
        amount = a
      }
      const { data: u, error: uErr } = await db.from("users").select("id").eq("id", t).maybeSingle()
      if (uErr) {
        logError("assign-user", uErr)
        return fail("credit_failed", 500)
      }
      if (!u) return fail("unknown_user", 400)
      target = t
    }
  } catch (err) {
    logError("credit-prep", err)
    return fail("credit_failed", 500)
  }

  return callRpc(
    db,
    "admin_credit_momo_transaction",
    { p_txid: txid, p_target_user: target, p_admin: userId, p_reason: reason, p_amount: amount },
    ["credited", "already_credited"],
    (result) => (result === "credited" ? alertAdminCredit(db, txid) : Promise.resolve()),
  )
}

/** Admin credit alert: amount, last 4 txid digits and a fixed reason. Never the target user. Never throws or logs. */
async function alertAdminCredit(db: Db, txid: string): Promise<void> {
  let amountPesewas: number | undefined
  try {
    const { data, error } = await db.from("momo_transactions").select("amount").eq("transaction_id", txid).maybeSingle()
    const raw = (data as { amount?: unknown } | null)?.amount
    const n = Number(raw)
    if (!error && raw !== null && raw !== undefined && Number.isFinite(n)) amountPesewas = Math.round(n * 100)
  } catch {
    // alert without the amount
  }
  try {
    await notifyMomoAdmins({
      kind: "credited",
      ...(amountPesewas === undefined ? {} : { amountPesewas }),
      txidLast4: txid.slice(-4),
      reasons: ["admin credit"],
    })
  } catch {
    // notifyMomoAdmins never throws; belt and braces
  }
}
