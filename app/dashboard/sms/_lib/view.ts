// Pure helpers for the customer SMS pages. No React, no I/O — unit-tested in view.test.ts.

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
    case "NOT_ACTIVATED": return "Activate SMS before sending."
    case "SUSPENDED": return "Your SMS account is suspended. Contact support."
    case "NO_VALID_RECIPIENTS": return "No valid Ghana numbers to send to."
    case "INVALID_SENDER_ID": return "That sender ID isn't available on your account."
    case "TOO_MANY_RECIPIENTS": return `You can send to at most ${MAX_RECIPIENTS.toLocaleString("en-US")} recipients at once.`
    case "SEND_ERROR": return "Sending failed — please try again."
    default: return fallback ?? code ?? "Something went wrong"
  }
}

export const limitsLine = (l: { perSend: number; perHour: number; perDay: number }) =>
  `${l.perSend.toLocaleString("en-US")} recipients/send · ${l.perHour.toLocaleString("en-US")} sends/hour · ${l.perDay.toLocaleString("en-US")} recipients/day`

export const MOMO_PHONE = /^0?\d{9}$/
