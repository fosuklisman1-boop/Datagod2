import { createClient } from "@supabase/supabase-js"
import { prepareSmsMessage, type ShopTokens } from "./prepare"
import { filterSmsContent } from "./content-filter"
import { calculateSegments } from "./segments"
import { drainSmsMessages } from "./send-drain"

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const MAX_RECIPIENTS = 500

/** Normalize a phone string to +233XXXXXXXXX (Moolre/E.164 format). */
function normalizePhoneNumber(phone: string): string | null {
  const cleaned = String(phone ?? "").replace(/[\s\-\(\)]/g, "")
  if (!cleaned) return null
  if (cleaned.startsWith("0") && cleaned.length === 10) return `+233${cleaned.slice(1)}`
  if (cleaned.startsWith("+233") && cleaned.length === 13) return cleaned
  if (cleaned.startsWith("233") && cleaned.length === 12) return `+${cleaned}`
  // 9-digit local without leading 0
  if (/^\d{9}$/.test(cleaned)) return `+233${cleaned}`
  return null
}

export interface EnqueueSendResult {
  ok: true
  sendLogId: string
  total: number
  segments: number
  creditsReserved: number
}

export interface EnqueueSendError {
  ok: false
  error: "EMPTY_MESSAGE" | "BLOCKED" | "TOO_MANY_RECIPIENTS" | "NOT_ACTIVATED" | "SUSPENDED" | "INSUFFICIENT_CREDITS"
  reason?: string
}

/**
 * Validate, filter, debit credits, and enqueue an SMS campaign for sending.
 * Fires a best-effort initial drain so the first batch goes out quickly.
 */
export async function enqueueSend(
  userId: string,
  accountId: string,
  message: string,
  recipients: string[],
  shopTokens?: ShopTokens
): Promise<EnqueueSendResult | EnqueueSendError> {
  // 1. Recipient cap (check BEFORE any debit)
  if (recipients.length > MAX_RECIPIENTS) {
    return { ok: false, error: "TOO_MANY_RECIPIENTS" }
  }

  // 2. Prepare message (token substitution + strip undeliverable chars)
  let prepared: string
  try {
    prepared = shopTokens
      ? prepareSmsMessage(message, shopTokens)
      : prepareSmsMessage(message, { shop_name: "", shop_link: "", shop_phone: "", shop_whatsapp: "" })
  } catch {
    return { ok: false, error: "EMPTY_MESSAGE" }
  }
  if (!prepared || prepared.trim().length === 0) {
    return { ok: false, error: "EMPTY_MESSAGE" }
  }

  // 3. Content filter
  const filterResult = filterSmsContent(prepared)
  if (filterResult.blocked) {
    // Log a blocked record (no debit, credits_used=0, credits_reserved=0)
    const seg = calculateSegments(prepared).segments
    await supabaseAdmin.from("sms_send_logs").insert({
      sms_account_id: accountId,
      user_id: userId,
      message,
      prepared_message: prepared,
      recipients_count: recipients.length,
      segments: seg,
      credits_used: 0,
      credits_reserved: 0,
      status: "blocked",
      flagged: true,
      flag_reason: filterResult.reason ?? "blocked",
    })
    return { ok: false, error: "BLOCKED", reason: filterResult.reason }
  }

  // 4. Compute segments + credits needed
  const seg = calculateSegments(prepared).segments
  const creditsNeeded = seg * recipients.length

  // 5. Debit via RPC
  const { error: rpcError } = await supabaseAdmin.rpc("debit_sms_for_send", {
    p_account_id: accountId,
    p_credits: creditsNeeded,
  })

  if (rpcError) {
    const msg = rpcError.message ?? ""
    if (msg.includes("NOT_ACTIVATED")) return { ok: false, error: "NOT_ACTIVATED" }
    if (msg.includes("SUSPENDED")) return { ok: false, error: "SUSPENDED" }
    if (msg.includes("INSUFFICIENT_CREDITS")) return { ok: false, error: "INSUFFICIENT_CREDITS" }
    // Re-throw unexpected errors
    throw rpcError
  }

  // 6. Insert the send log
  const { data: logData, error: logError } = await supabaseAdmin
    .from("sms_send_logs")
    .insert({
      sms_account_id: accountId,
      user_id: userId,
      message,
      prepared_message: prepared,
      recipients_count: recipients.length,
      segments: seg,
      credits_used: 0,            // updated after drain
      credits_reserved: creditsNeeded,
      status: "queued",
      flagged: filterResult.flagged,
      flag_reason: filterResult.flagged ? (filterResult.reason ?? null) : null,
    })
    .select("id")
    .single()

  if (logError || !logData) {
    throw logError ?? new Error("Failed to insert sms_send_logs row")
  }

  const sendLogId: string = logData.id

  // 7. Bulk-insert one sms_messages row per recipient
  const messageRows: Array<{
    send_log_id: string
    sms_account_id: string
    phone: string
    rendered_message: string
    segments: number
    status: string
  }> = []
  let invalidCount = 0

  for (const raw of recipients) {
    const phone = normalizePhoneNumber(raw)
    if (!phone) {
      invalidCount++
      continue
    }
    messageRows.push({
      send_log_id: sendLogId,
      sms_account_id: accountId,
      phone,
      rendered_message: prepared,
      segments: seg,
      status: "pending",
    })
  }

  if (messageRows.length > 0) {
    // Insert in chunks of 500 to stay under payload limits
    const chunkSize = 500
    for (let i = 0; i < messageRows.length; i += chunkSize) {
      const { error: msgError } = await supabaseAdmin
        .from("sms_messages")
        .insert(messageRows.slice(i, i + chunkSize))
      if (msgError) throw msgError
    }
  }

  if (invalidCount > 0) {
    console.warn(`[SMS-SEND] ${invalidCount} invalid phone(s) skipped for send_log ${sendLogId}`)
  }

  // 8. Best-effort initial drain
  drainSmsMessages({ limit: 50 }).catch(() => {})

  return {
    ok: true,
    sendLogId,
    total: recipients.length,
    segments: seg,
    creditsReserved: creditsNeeded,
  }
}
