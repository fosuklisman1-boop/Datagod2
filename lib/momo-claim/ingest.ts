import { randomUUID } from "crypto"
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

export class MomoStoreError extends Error {
  constructor() {
    super("momo sms row could not be stored")
    this.name = "MomoStoreError"
  }
}

export const MAX_SMS_LENGTH = 2000
const MAX_SENDER_LENGTH = 100
const TXID_RE = /^\d{8,15}$/
const TABLE = "momo_transactions"

const syntheticId = () => `X${randomUUID()}`
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

  // 1. Sender allowlist: exact match. Anything else is kept for the audit trail, never parsed.
  if (!from || !settings.senderAllowlist.includes(from)) {
    await insertOrThrow(client, {
      transaction_id: syntheticId(),
      raw_sms: text,
      sms_sender: from,
      status: "rejected_sender",
    })
    return "rejected_sender"
  }

  // 2. Prefilter: not a MoMo receipt at all.
  if (!passesPrefilter(text)) return "ignored"

  // 3. Parse. A MoMo-looking SMS we cannot read must reach the admin queue, never be dropped.
  const sms = parseMomoSms(text)
  if (!sms) {
    await insertOrThrow(client, {
      transaction_id: syntheticId(),
      raw_sms: text,
      sms_sender: from,
      status: "unparsed",
    })
    await notify({ kind: "unparsed" })
    return "unparsed"
  }

  // 4. Store first (ON CONFLICT DO NOTHING). A replayed txid stops here.
  const { data: inserted, error: insertError } = await client
    .from(TABLE)
    .upsert(
      {
        transaction_id: sms.transactionId,
        network: sms.network,
        pattern: sms.pattern,
        amount: ghs(sms.amountPesewas),
        sender_name: sms.senderName,
        sms_sender: from,
        sms_balance: sms.balancePesewas === null ? null : ghs(sms.balancePesewas),
        raw_sms: text,
        status: "pending",
      },
      { onConflict: "transaction_id", ignoreDuplicates: true },
    )
    .select("transaction_id")
  if (insertError || !Array.isArray(inserted)) throw new MomoStoreError()
  if (inserted.length === 0) return "duplicate"

  const base = { amountPesewas: sms.amountPesewas, txidLast4: last4(sms.transactionId) }

  // 5. Intake checks against OTHER rows. Unreadable state = flag (fail closed).
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
  if (flags.length > 0) {
    let reasons = flags
    try {
      const { error } = await client
        .from(TABLE)
        .update({ status: "flagged", flag_reasons: flags })
        .eq("transaction_id", sms.transactionId)
      if (error) reasons = [...flags, "flag_update_failed"]
    } catch {
      reasons = [...flags, "flag_update_failed"]
    }
    await notify({ kind: "flagged", ...base, reasons })
    return "flagged"
  }

  // 6. Feature off: stored and checked, never auto-credited.
  if (!settings.enabled) return "stored_pending"

  // 7. Exactly one live session code in the text, or nothing.
  const code = await findSingleLiveCode(client, text)
  if (!code) return "stored_pending"

  let result: unknown
  try {
    const { data, error } = await client.rpc("claim_via_wallet_topup_session", {
      p_code: code,
      p_txid: sms.transactionId,
    })
    if (error) throw new Error("rpc error")
    result = data
  } catch {
    await notify({ kind: "flagged", ...base, reasons: ["auto_credit_error"] })
    return "stored_pending"
  }

  if (result === "credited") {
    await notify({ kind: "credited", ...base })
    return "credited"
  }
  if (result === "under_review") {
    await notify({ kind: "flagged", ...base, reasons: await readFlagReasons(client, sms.transactionId) })
    return "under_review"
  }
  return "stored_pending"
}

async function insertOrThrow(client: SupabaseClient, row: Record<string, unknown>): Promise<void> {
  let failed = false
  try {
    const { error } = await client.from(TABLE).insert(row)
    failed = Boolean(error)
  } catch {
    failed = true
  }
  if (failed) throw new MomoStoreError()
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

/** The one pending, unexpired session whose code is in the text; null for zero, several, or a read error. */
async function findSingleLiveCode(client: SupabaseClient, text: string): Promise<string | null> {
  const candidates = scanCodeCandidates(text)
  if (candidates.length === 0) return null
  try {
    const { data, error } = await client
      .from("wallet_topup_sessions")
      .select("id, code")
      .eq("status", "pending")
      .gt("expires_at", new Date().toISOString())
      .in("code", candidates)
    if (error || !Array.isArray(data)) return null
    const ids = new Set((data as { id: unknown }[]).map((r) => r.id))
    if (ids.size !== 1) return null
    const code = (data[0] as { code?: unknown }).code
    return typeof code === "string" ? code : null
  } catch {
    return null
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
