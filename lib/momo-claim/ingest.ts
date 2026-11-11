import { createHash } from "crypto"
import type { SupabaseClient } from "@supabase/supabase-js"
import { parseMomoSms, passesPrefilter, type ParsedSms } from "./parse-sms"
import { scanCodeCandidates } from "./codes"
import { intakeFlags } from "./intake-checks"
import type { MomoClaimSettings } from "./settings"
import { notifyMomoAdmins, type MomoAdminAlert } from "@/lib/admin-actions/momo-claim"

/**
 * Stores one forwarded MoMo SMS, runs the intake fraud checks and, when exactly one live payment
 * code is in the text, asks the DB to auto-credit it. Server-only.
 *
 * Never logs: the SMS holds payer names, phone numbers and amounts. Alerts carry only the amount
 * and the last 4 transaction-ID digits.
 *
 * Every write is idempotent (ON CONFLICT DO NOTHING on transaction_id; synthetic ids are derived
 * from sender + text), so forwarder retries never create a second row or a second alert.
 * Intake flags go into the same single insert: a row is never pending while it should be flagged.
 *
 * Throws MomoStoreError only when the SMS row could not be written (the caller answers 503 so the
 * forwarder retries). Every later failure is contained: auto-credit is fail-closed.
 */

export type IngestOutcome =
  | "ignored"
  | "duplicate"
  | "rejected_sender"
  | "unparsed"
  | "flagged"
  | "stored_pending"
  | "credited"
  | "under_review"

export type IngestDeps = { notifyAdmins?: (alert: MomoAdminAlert) => Promise<void> }
type Notify = (alert: MomoAdminAlert) => Promise<void>

export class MomoStoreError extends Error {
  /** PostgREST/PG error code of the failed write, if any. Never the message (it can hold the txid). */
  readonly code: string | undefined
  constructor(code?: unknown) {
    super("momo sms row could not be stored")
    this.name = "MomoStoreError"
    this.code = typeof code === "string" && /^[A-Za-z0-9_]{1,20}$/.test(code) ? code : undefined
  }
}

export const MAX_SMS_LENGTH = 2000
const MAX_SENDER_LENGTH = 100
const TXID_RE = /^\d{8,15}$/
const TABLE = "momo_transactions"
const REDACTED = "[redacted]"

/** 'X' + UUID-shaped first 32 hex chars of sha256(sender + "\n" + text): same delivery, same id. */
export function syntheticId(sender: string | null, text: string): string {
  const h = createHash("sha256").update(`${sender ?? ""}\n${text}`, "utf8").digest("hex").slice(0, 32)
  return `X${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`
}

const ghs = (pesewas: number) => pesewas / 100
const last4 = (txid: string) => txid.slice(-4)

export async function ingestForwardedSms(
  client: SupabaseClient,
  input: { text: string; from: string | null },
  settings: MomoClaimSettings,
  deps: IngestDeps = {},
): Promise<IngestOutcome> {
  const notify = deps.notifyAdmins ?? notifyMomoAdmins
  const text = typeof input.text === "string" ? input.text : ""
  if (text.trim().length === 0 || text.length > MAX_SMS_LENGTH) return "ignored"

  const from = typeof input.from === "string" ? input.from.trim().slice(0, MAX_SENDER_LENGTH) : null
  const allowed = settings.senderAllowlist.map((s) => s.trim()).filter((s) => s.length > 0)

  // 1. Sender allowlist: exact match. Anything else is kept (text redacted) for the audit trail, never parsed.
  if (!from || !allowed.includes(from)) {
    const stored = await storeOrThrow(client, {
      transaction_id: syntheticId(from, text),
      raw_sms: REDACTED,
      sms_sender: from,
      status: "rejected_sender",
    })
    return stored ? "rejected_sender" : "duplicate"
  }

  // 2. Prefilter: not a MoMo receipt at all.
  if (!passesPrefilter(text)) return "ignored"

  // 3. Parse. A MoMo-looking SMS we cannot read must reach the admin queue, never be dropped.
  const sms = parseMomoSms(text)
  if (!sms) {
    const stored = await storeOrThrow(client, {
      transaction_id: syntheticId(from, text),
      raw_sms: text,
      sms_sender: from,
      status: "unparsed",
    })
    if (!stored) return "duplicate"
    await notify({ kind: "unparsed" })
    return "unparsed"
  }

  // 4. Intake checks against OTHER rows, before the insert. Unreadable state = flag (fail closed).
  let flags: string[]
  try {
    flags = intakeFlags(sms, {
      ...(await readIntakeState(client, sms)),
      maxSentPesewas: settings.maxSentPesewas,
      regressionThreshold: Math.floor(settings.regressionThreshold),
    })
  } catch {
    flags = ["intake_check_error"]
  }

  // 5. One insert, flags included (ON CONFLICT DO NOTHING).
  const stored = await storeOrThrow(client, {
    transaction_id: sms.transactionId,
    network: sms.network,
    pattern: sms.pattern,
    amount: ghs(sms.amountPesewas),
    sender_name: sms.senderName,
    sms_sender: from,
    sms_balance: sms.balancePesewas === null ? null : ghs(sms.balancePesewas),
    raw_sms: text,
    status: flags.length > 0 ? "flagged" : "pending",
    flag_reasons: flags,
  })
  if (!stored) return retryDuplicate(client, sms.transactionId, settings, notify)

  const base = { amountPesewas: sms.amountPesewas, txidLast4: last4(sms.transactionId) }
  if (flags.length > 0) {
    await notify({ kind: "flagged", ...base, reasons: flags })
    return "flagged"
  }

  // 6. Feature off: stored and checked, never auto-credited.
  if (!settings.enabled) return "stored_pending"

  const outcome = await autoCredit(client, text, sms.transactionId, base, notify)
  return outcome ?? "stored_pending"
}

/**
 * A txid we already hold. Only a row still 'pending' gets another auto-credit attempt, and only
 * with the STORED text: a replay carrying a different code must never steer the payment.
 */
async function retryDuplicate(
  client: SupabaseClient,
  txid: string,
  settings: MomoClaimSettings,
  notify: Notify,
): Promise<IngestOutcome> {
  if (!settings.enabled) return "duplicate"
  let row: { status?: unknown; raw_sms?: unknown; amount?: unknown } | null
  try {
    const { data, error } = await client
      .from(TABLE)
      .select("status, raw_sms, amount")
      .eq("transaction_id", txid)
      .maybeSingle()
    if (error) return "duplicate"
    row = data as typeof row
  } catch {
    return "duplicate"
  }
  if (!row || row.status !== "pending" || typeof row.raw_sms !== "string") return "duplicate"
  const amount = Number(row.amount)
  const base = {
    ...(Number.isFinite(amount) ? { amountPesewas: Math.round(amount * 100) } : {}),
    txidLast4: last4(txid),
  }
  const outcome = await autoCredit(client, row.raw_sms, txid, base, notify)
  return outcome === "credited" || outcome === "under_review" ? outcome : "duplicate"
}

/** Code matching + RPC. Returns null when nothing was credited or sent to review. */
async function autoCredit(
  client: SupabaseClient,
  text: string,
  txid: string,
  base: { amountPesewas?: number; txidLast4: string },
  notify: Notify,
): Promise<"credited" | "under_review" | null> {
  const match = await findSingleLiveCode(client, text)
  if (match === "error") {
    await notify({ kind: "flagged", ...base, reasons: ["auto_credit_error"] })
    return null
  }
  if (!match) return null

  let result: unknown
  try {
    const { data, error } = await client.rpc("claim_via_wallet_topup_session", { p_code: match, p_txid: txid })
    if (error) throw new Error("rpc error")
    result = data
  } catch {
    await notify({ kind: "flagged", ...base, reasons: ["auto_credit_error"] })
    return null
  }

  if (result === "credited") {
    await notify({ kind: "credited", ...base })
    return "credited"
  }
  if (result === "under_review") {
    await notify({ kind: "flagged", ...base, reasons: await readFlagReasons(client, txid) })
    return "under_review"
  }
  return null
}

/** Insert with ON CONFLICT (transaction_id) DO NOTHING. true = new row, false = already there. */
async function storeOrThrow(client: SupabaseClient, row: Record<string, unknown>): Promise<boolean> {
  let result: { data: unknown; error: unknown }
  try {
    result = await client
      .from(TABLE)
      .upsert(row, { onConflict: "transaction_id", ignoreDuplicates: true })
      .select("transaction_id")
  } catch (err) {
    throw new MomoStoreError((err as { code?: unknown } | null)?.code)
  }
  if (result.error) throw new MomoStoreError((result.error as { code?: unknown }).code)
  if (!Array.isArray(result.data)) throw new MomoStoreError()
  return result.data.length > 0
}

/** Throws on any read error; the caller turns that into a flag. */
async function readIntakeState(
  client: SupabaseClient,
  sms: ParsedSms,
): Promise<{ newestTxid: string | null; balanceSeenOnOtherTxid: boolean }> {
  // Largest numeric txid among other live rows. Text ordering is only numeric within one length,
  // so take the top row per length (LIKE with N underscores = exactly N chars) and compare as BigInt.
  const lengths = [8, 9, 10, 11, 12, 13, 14, 15]
  const tops = await Promise.all(
    lengths.map(async (n) => {
      const { data, error } = await client
        .from(TABLE)
        .select("transaction_id")
        .in("status", ["pending", "claimed"])
        .neq("transaction_id", sms.transactionId)
        .like("transaction_id", "_".repeat(n))
        .order("transaction_id", { ascending: false })
        .limit(1)
      if (error || !Array.isArray(data)) throw new Error("intake read failed")
      const id = (data[0] as { transaction_id?: unknown } | undefined)?.transaction_id
      return typeof id === "string" && TXID_RE.test(id) ? id : null
    }),
  )
  let newestTxid: string | null = null
  for (const id of tops) {
    if (id !== null && (newestTxid === null || BigInt(id) > BigInt(newestTxid))) newestTxid = id
  }

  let balanceSeenOnOtherTxid = false
  if (sms.balancePesewas !== null) {
    const { data, error } = await client
      .from(TABLE)
      .select("transaction_id")
      .eq("sms_balance", ghs(sms.balancePesewas))
      .neq("transaction_id", sms.transactionId)
      .limit(1)
    if (error || !Array.isArray(data)) throw new Error("intake read failed")
    balanceSeenOnOtherTxid = data.length > 0
  }

  return { newestTxid, balanceSeenOnOtherTxid }
}

/** The one pending, unexpired session whose code is in the text; null for zero or several; "error" on a read failure. */
async function findSingleLiveCode(client: SupabaseClient, text: string): Promise<string | null | "error"> {
  const candidates = scanCodeCandidates(text)
  if (candidates.length === 0) return null
  try {
    const { data, error } = await client
      .from("wallet_topup_sessions")
      .select("id, code")
      .eq("status", "pending")
      .gt("expires_at", new Date().toISOString())
      .in("code", candidates)
    if (error || !Array.isArray(data)) return "error"
    const ids = new Set((data as { id: unknown }[]).map((r) => r.id))
    if (ids.size !== 1) return null
    const code = (data[0] as { code?: unknown }).code
    return typeof code === "string" && candidates.includes(code) ? code : null
  } catch {
    return "error"
  }
}

async function readFlagReasons(client: SupabaseClient, txid: string): Promise<string[]> {
  try {
    const { data } = await client.from(TABLE).select("flag_reasons").eq("transaction_id", txid).maybeSingle()
    const reasons = (data as { flag_reasons?: unknown } | null)?.flag_reasons
    return Array.isArray(reasons) ? reasons.filter((r): r is string => typeof r === "string") : []
  } catch {
    return []
  }
}
