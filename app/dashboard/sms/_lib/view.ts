// Pure helpers for the customer SMS pages. No React, no I/O — unit-tested in view.test.ts.
// kyc-rules and sender-name are pure (no server imports), so client and server share one set of rules.
import { validateKycDraft, docExtension, type KycStatus } from "@/lib/sms/kyc-rules"
import { validateSenderName, SENDER_NAME_MAX } from "@/lib/sms/sender-name"

export interface ShopTokens { shop_name: string; shop_link: string; shop_phone: string; shop_whatsapp: string }
export type VerifyStatus = "unverified" | "pending" | "verified" | "invalid"
export interface Contact {
  id: string; group_id: string; first_name: string | null; last_name: string | null
  phone_number: string; opted_out: boolean; verify_status: VerifyStatus
  verified_name: string | null; verified_at: string | null; created_at: string
}
export type BulkRow = { phone_number: string; first_name?: string; last_name?: string }

/** Mirrors server SMS_MAX_TOTAL. */
export const MAX_RECIPIENTS = 5000

// Quick-insert chips: {shop_*} tokens are resolved server-side (and previewed
// client-side); Promo / Order now drop in handy starter text.
export const INSERT_CHIPS: { label: string; insert: string }[] = [
  { label: "Shop Name", insert: "{shop_name}" },
  { label: "Shop Link", insert: "{shop_link}" },
  { label: "Phone", insert: "{shop_phone}" },
  { label: "WhatsApp", insert: "{shop_whatsapp}" },
  { label: "Promo", insert: "Special offer: " },
  { label: "Order now", insert: "Order now: {shop_link}" },
]

/** Resolve {shop_*} tokens for the live preview. Function replacers so a token
 *  value containing a `$` pattern can't splice text into the slot. Empty values
 *  leave the literal token visible (so unconfigured fields are obvious). */
export function resolveTokens(msg: string, t: ShopTokens | null): string {
  if (!t) return msg
  return msg
    .replaceAll("{shop_name}", () => t.shop_name || "{shop_name}")
    .replaceAll("{shop_link}", () => t.shop_link || "{shop_link}")
    .replaceAll("{shop_phone}", () => t.shop_phone || "{shop_phone}")
    .replaceAll("{shop_whatsapp}", () => t.shop_whatsapp || "{shop_whatsapp}")
}

/** Split a free-typed string into individual numbers (comma / space / newline). */
export function splitNumbers(raw: string): string[] {
  return raw.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean)
}

/** Parse CSV/paste text into contact rows. Each line: phone[,firstName[,lastName]]
 *  — PHONE FIRST. A header row on line 0 is tolerated (skipped only if its first
 *  cell has no digit). Empty name cells become undefined. */
export function parseRows(text: string): BulkRow[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  const rows: BulkRow[] = []
  lines.forEach((line, i) => {
    const [phone_number, first_name, last_name] = line.split(",").map((p) => p.trim())
    if (!phone_number) return
    if (i === 0 && !/\d/.test(phone_number)) return // tolerate a header row
    rows.push({ phone_number, first_name: first_name || undefined, last_name: last_name || undefined })
  })
  return rows
}

/** Display name for a contact: typed name → verified MoMo name → em-dash. */
export function contactName(c: Contact): string {
  const typed = [c.first_name, c.last_name].filter(Boolean).join(" ")
  return typed || c.verified_name || "—"
}

/** Generate a few plausible sender-ID suggestions from the shop's own name
 *  (letters/numbers only, 11-char max — same constraint the input enforces). */
export function senderSuggestions(shopName: string): string[] {
  const clean = shopName.replace(/[^a-zA-Z0-9 ]/g, "").trim()
  if (!clean) return []
  const compact = clean.replace(/\s+/g, "").toUpperCase().slice(0, 11)
  const words = clean.split(/\s+/).filter(Boolean)
  const initials = words.map((w) => w[0]).join("").toUpperCase()
  const out = [
    compact,
    initials.length >= 2 ? initials.slice(0, 11) : compact.slice(0, 4),
    (compact.slice(0, 9) + "GH").slice(0, 11),
    (compact.slice(0, 8) + "HUB").slice(0, 11),
  ]
  return Array.from(new Set(out.filter((s) => s.length >= 2)))
}

// ─── new helpers ──────────────────────────────────────────────────────────
export type Tone = "success" | "warning" | "danger" | "muted" | "info"

const LOG_STATUS: Record<string, { label: string; tone: Tone }> = {
  queued: { label: "Queued", tone: "info" }, sending: { label: "Processing", tone: "info" },
  sent: { label: "Completed", tone: "success" }, partial: { label: "Partial", tone: "warning" },
  failed: { label: "Failed", tone: "danger" }, blocked: { label: "Blocked", tone: "danger" },
  held: { label: "Under review", tone: "warning" }, scheduled: { label: "Scheduled", tone: "muted" },
}
export function logStatus(s: string) { return LOG_STATUS[s] ?? { label: s, tone: "muted" as Tone } }

/** True while a batch still has work the cron will keep processing. */
export const isInFlight = (s: string) => s === "queued" || s === "sending"

export function addNumbers(existing: string[], raw: string, cap = MAX_RECIPIENTS): { list: string[]; added: number; capped: boolean } {
  const seen = new Set(existing); const list = [...existing]; let added = 0; let capped = false
  for (const n of splitNumbers(raw)) {
    if (seen.has(n)) continue
    if (list.length >= cap) { capped = true; break }
    seen.add(n); list.push(n); added++
  }
  return { list, added, capped }
}

export function costSummary(recipients: number, segmentsPerRecipient: number, balance: number) {
  const total = recipients * segmentsPerRecipient
  return { total, short: Math.max(0, total - balance), overBudget: total > balance }
}

export const perSms = (priceGhs: number, units: number) => (units > 0 ? priceGhs / units : 0)

export function bestValueId(bundles: { id: string; price_ghs: number; units: number }[]) {
  let best: string | null = null; let low = Infinity
  for (const b of bundles) { const p = perSms(b.price_ghs, b.units); if (p > 0 && p < low) { low = p; best = b.id } }
  return bundles.length > 1 ? best : null
}

/** Kept in step with ledgerLabel in lib/sms/customer-reads.ts. */
export function ledgerLabel(reason: string, sendLogId: number | null): string {
  switch (reason) {
    case "bundle_wallet": case "bundle_paystack": return "Credits purchased"
    case "welcome_bonus": return "Welcome bonus"
    case "admin_alloc": return "Credits added by support"
    case "campaign_send": return sendLogId ? `SMS campaign #${sendLogId}` : "SMS campaign"
    case "campaign_refund": return sendLogId ? `Refund — campaign #${sendLogId}` : "Refund — failed delivery"
    default: return "Credit adjustment"
  }
}

export function sendErrorMessage(code: string | undefined, reason?: string, fallback?: string): string {
  switch (code) {
    case "INSUFFICIENT_CREDITS": return "Not enough SMS credits — buy more and try again."
    case "SMS_DISABLED": return "SMS is temporarily unavailable. Please try again later."
    case "BLOCKED": return reason ? `Message blocked: ${reason}` : "This message was blocked by our content rules."
    // The send policy's reason is written for customers ("what to change") — show it verbatim.
    case "POLICY_REJECTED": return reason?.trim() ? reason : "This send isn't allowed right now. Check your limits and message, then try again."
    case "NOT_ACTIVATED": return "Activate SMS before sending."
    case "SUSPENDED": return "Your SMS account is suspended. Contact support."
    case "NO_VALID_RECIPIENTS": return "No valid Ghana numbers to send to."
    case "INVALID_SENDER_ID": return "That sender ID isn't available on your account."
    case "TOO_MANY_RECIPIENTS": return `You can send to at most ${MAX_RECIPIENTS.toLocaleString("en-US")} recipients at once.`
    case "SEND_ERROR": return "Sending failed — please try again."
    case "INVALID_SCHEDULE": return reason?.trim() || fallback || "Pick a valid time to send (2 minutes to 30 days from now)."
    case "SEND_IN_PROGRESS": return "Another send from your account is still being processed. Please try again in a few seconds."
    default: return fallback ?? code ?? "Something went wrong"
  }
}

/** Toast for a send the policy held for admin review (credits reserved, nothing sent yet). */
export const HELD_SEND_MESSAGE = "Sent for a quick review — you'll be notified"

/** Why a batched send stopped part-way (BatchedSendResult.stoppedReason → customer text). */
export function partialStopReason(stoppedReason: string | undefined): string {
  switch (stoppedReason) {
    case "INSUFFICIENT_CREDITS": return "ran out of credits — top up and resend the rest"
    case "SUSPENDED": return "the account was suspended mid-send"
    case "SMS_DISABLED": return "SMS was paused by the platform — resend the rest later"
    case "NOT_ACTIVATED": return "the account is no longer active"
    default: return "the rest could not be sent"
  }
}

const recipientsText = (n: number) => `${n.toLocaleString("en-US")} recipient${n !== 1 ? "s" : ""}`

/** Toast after a successful POST /api/shop/sms/send (held and/or partial outcomes included). */
export function sendOutcomeMessage(r: {
  held?: boolean; partial?: boolean; stoppedReason?: string; total?: number; batches?: number; creditsReserved?: number
  scheduled?: boolean; scheduledFor?: string | null
}): { tone: "success" | "warning"; text: string } {
  const total = r.total ?? 0
  const batches = r.batches ?? 1
  const batchTxt = batches > 1 ? ` in ${batches} batches` : ""
  if (r.scheduled) {
    const when = r.scheduledFor ? formatScheduled(r.scheduledFor) : ""
    const forWhen = when ? ` for ${when}` : ""
    const heldNote = r.held ? " Part of it was sent for a quick review and goes out when approved, not at the scheduled time." : ""
    if (r.partial) {
      // Nothing has been sent yet: the accepted part is only scheduled.
      return {
        tone: "warning",
        text: `${recipientsText(total)} scheduled${forWhen}, then ${partialStopReason(r.stoppedReason)}. Schedule the rest separately.${heldNote}`,
      }
    }
    return {
      tone: "success",
      text: `Scheduled${forWhen} — credits reserved. You can cancel from Records until then.${heldNote}`,
    }
  }
  if (r.held && r.partial) {
    return {
      tone: "warning",
      text: `${recipientsText(total)} sent for a quick review — you'll be notified. The rest were not sent: ${partialStopReason(r.stoppedReason)}.`,
    }
  }
  if (r.held) return { tone: "success", text: HELD_SEND_MESSAGE }
  if (r.partial) return { tone: "warning", text: `Sent ${recipientsText(total)}${batchTxt}, then ${partialStopReason(r.stoppedReason)}.` }
  return { tone: "success", text: `Queued ${recipientsText(total)}${batchTxt} (${r.creditsReserved ?? 0} credits)` }
}

/** Internal per-recipient error codes → customer text. Anything else (provider messages) shows as-is. */
const RECIPIENT_ERRORS: Record<string, string> = {
  held_rejected: "Not approved after review — credits refunded",
  hubtel_unconfirmed: "Delivery could not be confirmed",
  scheduled_cancelled: "Scheduled send cancelled — credits refunded",
}
export function recipientErrorText(lastError: string | null | undefined): string {
  if (!lastError) return ""
  return RECIPIENT_ERRORS[lastError] ?? lastError
}

export const limitsLine =(l: { perSend: number; perHour: number; perDay: number }) =>
  `${l.perSend.toLocaleString("en-US")} recipients/send · ${l.perHour.toLocaleString("en-US")} sends/hour · ${l.perDay.toLocaleString("en-US")} recipients/day`

export const MOMO_PHONE = /^0?\d{9}$/

// ─── Credits ──────────────────────────────────────────────────────────────
/** Wallet when the main wallet covers the price, otherwise a Paystack redirect. */
export function purchaseMethod(walletBalance: number, priceGhs: number): "wallet" | "paystack" {
  return walletBalance >= priceGhs ? "wallet" : "paystack"
}

/** GH₵ still missing from the wallet for a bundle (0 when affordable). */
export function walletShortfall(walletBalance: number, priceGhs: number): number {
  return Math.max(0, Math.round((priceGhs - walletBalance) * 100) / 100)
}

/** Why Buy is disabled, or null when purchases are allowed. */
export function buyBlockedReason(a: { featureEnabled: boolean; status: string | null | undefined }): string | null {
  if (!a.featureEnabled) return "SMS is temporarily unavailable. Please try again later."
  if (a.status === "suspended") return "Your SMS account is suspended. Contact support."
  if (a.status !== "active") return "Activate your SMS account before buying credits."
  return null
}

/** Toast text for a failed purchase request (same wording as the old monolith). */
export function buyErrorMessage(error: string, code?: string): string {
  if (code === "SMS_DISABLED") return "SMS is temporarily unavailable. Please try again later."
  if (error === "Insufficient wallet balance") return "Insufficient wallet balance. Top up your wallet or pay with Paystack."
  if (error === "NOT_ACTIVATED") return "Activate your SMS account first."
  return error
}

export interface PurchaseOutcome { kind: "redirect" | "pending" | "success"; url?: string }
/** Interprets a successful purchase response body. */
export function purchaseOutcome(body: { authorizationUrl?: unknown; pending?: unknown }): PurchaseOutcome {
  if (typeof body.authorizationUrl === "string" && body.authorizationUrl) return { kind: "redirect", url: body.authorizationUrl }
  if (body.pending) return { kind: "pending" }
  return { kind: "success" }
}

/** Ledger delta as "+120" / "−5" (true minus sign). */
export function formatDelta(delta: number): string {
  const n = Math.abs(Number(delta) || 0).toLocaleString("en-US")
  return delta > 0 ? `+${n}` : delta < 0 ? `−${n}` : n
}

// ─── Records ──────────────────────────────────────────────────────────────
export const RECORDS_PAGE_SIZE = 25

/** Status filter chips on the Records list; `values` are sms_send_logs.status values ([] = no filter). */
export const RECORD_CHIPS: { key: string; label: string; values: string[] }[] = [
  { key: "all", label: "All", values: [] },
  { key: "queued", label: "Queued", values: ["queued"] },
  { key: "processing", label: "Processing", values: ["sending"] },
  { key: "completed", label: "Completed", values: ["sent"] },
  { key: "partial", label: "Partial", values: ["partial"] },
  { key: "failed", label: "Failed", values: ["failed"] },
  { key: "held", label: "Held", values: ["held"] },
  { key: "scheduled", label: "Scheduled", values: ["scheduled"] },
]

/** Value for `?status=` for a chip key ("" = all; unknown keys also mean all). */
export function chipStatus(key: string): string {
  return RECORD_CHIPS.find((c) => c.key === key)?.values[0] ?? ""
}

// ─── Scheduled sends (Ghana is GMT / UTC+0, so datetime-local values are read and written as UTC) ───
const MIN_SCHEDULE_MS = 2 * 60_000
const MAX_SCHEDULE_MS = 30 * 24 * 3_600_000
export const SCHEDULED_CANCEL_CONFIRM = "Cancel this scheduled send? Credits for unsent messages will be refunded."

/** Earliest / latest allowed send time (mirrors lib/sms/schedule.ts, which the server enforces). */
export function scheduleBounds(now: Date): { min: Date; max: Date } {
  return { min: new Date(now.getTime() + MIN_SCHEDULE_MS), max: new Date(now.getTime() + MAX_SCHEDULE_MS) }
}

/** Date -> "YYYY-MM-DDTHH:mm" in UTC, for <input type="datetime-local">. */
export function toLocalInputValue(d: Date): string {
  return d.toISOString().slice(0, 16)
}

/** datetime-local value (read as GMT) -> ISO UTC string, or null when empty/invalid. */
export function fromLocalInputValue(v: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v)) return null
  const d = new Date(`${v}:00.000Z`)
  return Number.isFinite(d.getTime()) ? d.toISOString() : null
}

/** null = acceptable; otherwise the customer-facing reason (same wording as the server). */
export function scheduleError(iso: string | null, now: Date): string | null {
  if (!iso) return "Pick a date and time to send"
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return "Pick a date and time to send"
  const ahead = ms - now.getTime()
  if (ahead < MIN_SCHEDULE_MS) return "Pick a time at least 2 minutes from now"
  if (ahead > MAX_SCHEDULE_MS) return "You can schedule up to 30 days ahead"
  return null
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
/** "12 Oct, 15:30 GMT" (empty string for an invalid date). */
export function formatScheduled(iso: string): string {
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return ""
  const hh = String(d.getUTCHours()).padStart(2, "0"), mm = String(d.getUTCMinutes()).padStart(2, "0")
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}, ${hh}:${mm} GMT`
}

/** A cancelled scheduled send is stored as failed; the read model derives `cancelled`. */
// ─── billed order confirmations (Home toggle + Records tag) ──────────────
export const ORDER_CONFIRMATION_HELP =
  "Customers get your order confirmation from your own sender ID. Costs 1 credit per message segment."
export const ORDER_CONFIRMATION_TAG = "Order confirmation"
export const isOrderConfirmation = (l: { source?: string | null }) => l.source === "order_confirmation"

export interface ConfirmationState { useOwnSender: boolean; canEnable: boolean; reason?: string }

/** Switch state for the Home toggle: loading until the GET answers, locked while saving or when it can't be enabled. */
export function confirmationToggleState(
  s: ConfirmationState | null | undefined,
  saving: boolean
): { checked: boolean; disabled: boolean; reason: string | null } {
  if (!s) return { checked: false, disabled: true, reason: null }
  // Turning OFF is always allowed; only turning ON needs eligibility.
  const blocked = !s.canEnable && !s.useOwnSender
  return { checked: s.useOwnSender, disabled: saving || blocked, reason: blocked ? (s.reason ?? "Not available yet.") : null }
}

export const isCancelledLog =(l: { status: string; cancelled?: boolean | null }) => l.status === "failed" && l.cancelled === true

export function pageCount(total: number, pageSize = RECORDS_PAGE_SIZE): number {
  return Math.max(1, Math.ceil((Number(total) || 0) / pageSize))
}

export function formatCount(n: unknown): string {
  const v = Number(n)
  return Number.isFinite(v) ? v.toLocaleString("en-US") : "0"
}

export function toneBadgeClass(t: Tone): string {
  switch (t) {
    case "success": return "border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
    case "warning": return "border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-300"
    case "danger": return "border-transparent bg-red-500/15 text-red-700 dark:text-red-300"
    case "info": return "border-transparent bg-primary/10 text-primary"
    default: return "border-transparent bg-muted text-muted-foreground"
  }
}

export function timeAgo(iso: string, now = Date.now()): string {
  const diff = now - new Date(iso).getTime()
  if (!Number.isFinite(diff)) return ""
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return "just now"
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days < 30) return `${days}d ago`
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" })
}

/** Customer wording for one recipient row of a batch. */
export function recipientStatus(m: { status: string; delivery_status?: string | null; refunded?: boolean | null }): { label: string; tone: Tone } {
  if (m.refunded) return { label: "Refunded", tone: "muted" }
  if (m.delivery_status === "delivered") return { label: "Delivered", tone: "success" }
  if (m.status === "failed" || m.delivery_status === "failed") return { label: "Failed", tone: "danger" }
  if (m.status === "sent") return { label: "Sent", tone: "info" }
  if (m.status === "claimed") return { label: "Sending", tone: "info" }
  return { label: "Queued", tone: "muted" }
}

// ─── Business & Sender ID ─────────────────────────────────────────────────
export type SenderStatus = "pending" | "active" | "rejected" | "paused" | "revoked"
export const SENDER_OPEN_STATUSES: string[] = ["pending", "active", "paused"]

const SENDER_STATUS_META: Record<string, { label: string; tone: Tone }> = {
  pending: { label: "Under review", tone: "warning" }, active: { label: "Active", tone: "success" },
  rejected: { label: "Rejected", tone: "danger" }, paused: { label: "Paused", tone: "muted" },
  revoked: { label: "Revoked", tone: "danger" },
}
export function senderStatus(s: string): { label: string; tone: Tone } {
  return SENDER_STATUS_META[s] ?? { label: s, tone: "muted" }
}

/** Mirrors senderLimitFor in sender-rules-service (the server enforces; this only hides the form). */
export const senderLimit = (mode: "platform" | "business" | null | undefined) => (mode === "business" ? 200 : 1)

export function openSenderCount(rows: { local_status: string }[]): number {
  return rows.filter((r) => SENDER_OPEN_STATUSES.includes(r.local_status)).length
}

/** null = may request; otherwise the customer-facing reason the request form is hidden. */
export function senderRequestBlock(mode: "platform" | "business" | null | undefined, rows: { local_status: string }[]): string | null {
  if (openSenderCount(rows) < senderLimit(mode)) return null
  return mode === "business"
    ? "You've reached the limit of 200 sender IDs."
    : "Platform mode includes one free sender ID. Verify your business to request up to 200."
}

/** Uppercase, letters/digits/spaces only, max 11 (the input constraint). */
export function formatSenderInput(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9 ]/g, "").slice(0, SENDER_NAME_MAX)
}

/** Client-side format check. Protected-name rules are server-only and surface on request. */
export function checkSenderInput(raw: string): { ok: true; name: string } | { ok: false; reason: string } {
  return validateSenderName(raw, [])
}

export interface KycForm { business_name: string; description: string; website: string; whatsapp_number: string; ghana_card_number: string }
export const EMPTY_KYC_FORM: KycForm = { business_name: "", description: "", website: "", whatsapp_number: "", ghana_card_number: "" }

export interface KycProfileView {
  status: KycStatus; business_name: string | null; description: string | null; website: string | null
  whatsapp_number: string | null; ghana_card_last4: string | null; rejection_reason?: string | null
  has_ghana_card_doc: boolean; has_registration_doc: boolean
}

/** Pre-fill the form from a saved profile. The card number is never returned, so it starts blank. */
export function kycFormFromProfile(p: KycProfileView | null): KycForm {
  if (!p) return { ...EMPTY_KYC_FORM }
  return {
    business_name: p.business_name ?? "", description: p.description ?? "", website: p.website ?? "",
    whatsapp_number: p.whatsapp_number ?? "", ghana_card_number: "",
  }
}

export const cardEnding = (last4: string | null | undefined) => (last4 ? `ID ending ${last4}` : null)

/** Payload for PUT /api/sms/business: only fields with content, plus website (so it can be cleared). */
export function kycPayload(f: KycForm): Record<string, string> {
  const out: Record<string, string> = { website: f.website }
  for (const k of ["business_name", "description", "whatsapp_number", "ghana_card_number"] as const) {
    if (f[k].trim()) out[k] = f[k]
  }
  return out
}

/** Field errors for what has been typed (empty fields are skipped; kycSubmitGaps covers required ones). */
export function kycFieldErrors(f: KycForm): Record<string, string> {
  const r = validateKycDraft(kycPayload(f))
  return r.ok ? {} : r.errors
}

/** Required items still missing before Submit is meaningful. */
export function kycSubmitGaps(f: KycForm, p: KycProfileView | null): string[] {
  const gaps: string[] = []
  // A rejected application is replaced by a fresh draft that carries over no card number or documents.
  const carried = p?.status !== "rejected"
  if (!f.business_name.trim()) gaps.push("Business name")
  if (!f.description.trim()) gaps.push("Description")
  if (!f.whatsapp_number.trim()) gaps.push("WhatsApp number")
  if (!f.ghana_card_number.trim() && !(carried && p?.ghana_card_last4)) gaps.push("Ghana Card number")
  if (!(carried && p?.has_ghana_card_doc)) gaps.push("Ghana Card photo")
  return gaps
}

/** Client pre-check of a chosen document (type/size), same rules as the server. */
export function checkKycFile(file: { type: string; size: number }): string | null {
  const r = docExtension(file.type, file.size)
  return r.ok ? null : r.error
}

/** Editable with no application, a draft, or after a rejection (saving then starts a fresh draft). */
export const kycEditable = (status: KycStatus | null | undefined) => !status || status === "draft" || status === "rejected"

export const STEPPER_LABELS = ["Register", "In review", "Approved", "Sender ID"] as const
export type StepState = "done" | "current" | "todo" | "error"

/** Register -> In review -> Approved -> Sender ID, from the KYC status and whether an own sender is active. */
export function kycSteps(status: KycStatus | null | undefined, hasActiveSender: boolean): { label: string; state: StepState }[] {
  let current = 0
  if (status === "submitted") current = 1
  else if (status === "approved") current = hasActiveSender ? 4 : 3
  return STEPPER_LABELS.map((label, i) => {
    if (status === "rejected" && i === 0) return { label, state: "error" as StepState }
    return { label, state: (i < current ? "done" : i === current ? "current" : "todo") as StepState }
  })
}
