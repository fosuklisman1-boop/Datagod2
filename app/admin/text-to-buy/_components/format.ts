import { calculateSegments } from "@/lib/sms/segments"

// Pure display helpers for the Text-to-Buy admin page. No I/O, no logging.

const MIN = 60_000

/** "Never" for null, else "just now" / "5 min ago" / "3 h ago" / "2 d ago". */
export function relativeTime(iso: string | null, now: Date): string {
  if (!iso) return "Never"
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return "Never"
  const diff = now.getTime() - t
  if (diff < MIN) return "just now"
  if (diff < 60 * MIN) return `${Math.floor(diff / MIN)} min ago`
  if (diff < 24 * 60 * MIN) return `${Math.floor(diff / (60 * MIN))} h ago`
  return `${Math.floor(diff / (24 * 60 * MIN))} d ago`
}

/** True when the phone has never been heard or was last heard longer ago than the alert threshold. */
export function isQuiet(iso: string | null, now: Date, quietAlertMinutes: number): boolean {
  if (!iso) return true
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return true
  return now.getTime() - t > quietAlertMinutes * MIN
}

export type FunnelCounts = { texts: number; prompts: number; paid: number; delivered: number }

/** texts -> prompts -> paid -> delivered; pct is a whole-number percentage of the previous step (null when there is none). */
export function funnelSteps(c: FunnelCounts): { label: string; count: number; pct: number | null }[] {
  const steps = [
    { label: "Texts", count: c.texts },
    { label: "Prompts", count: c.prompts },
    { label: "Paid", count: c.paid },
    { label: "Delivered", count: c.delivered },
  ]
  return steps.map((s, i) => ({
    ...s,
    pct: i === 0 || steps[i - 1].count <= 0 ? null : Math.round((s.count / steps[i - 1].count) * 100),
  }))
}

export function readSplit(ruleReads: number, aiReads: number): string {
  const total = ruleReads + aiReads
  if (total <= 0) return "No texts read yet today"
  const rules = Math.round((ruleReads / total) * 100)
  return `Read by rules ${rules}% / AI ${100 - rules}%`
}

/** The rate comes from the API (smsRateGhs); it is never fixed in the UI. */
export function smsCostText(replies: number, rateGhs: number): string {
  return `Reply SMS today: ${replies} (about GHS ${(replies * rateGhs).toFixed(2)})`
}

const OUTCOME_LABELS: Record<string, string> = {
  prompted: "Payment prompt sent",
  asked: "Asked a question",
  price_answer: "Price answer",
  keyword: "Keyword reply",
  late: "Too late to pay",
  limited: "Rate limited",
  open_order: "Order already open",
  not_order: "Not an order",
  unavailable: "Bundle unavailable",
  blocked: "Blocked number",
  duplicate: "Duplicate text",
  off: "Feature off",
  error: "Error",
}
export const OUTCOME_VALUES = Object.keys(OUTCOME_LABELS)

export function outcomeLabel(outcome: string | null): string {
  if (!outcome) return "-"
  return Object.prototype.hasOwnProperty.call(OUTCOME_LABELS, outcome) ? OUTCOME_LABELS[outcome] : outcome
}

/** Badge colours: good, needs a look, or neutral. */
export function outcomeTone(outcome: string | null): string {
  switch (outcome) {
    case "prompted":
    case "price_answer":
    case "keyword":
      return "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"
    case "error":
    case "blocked":
    case "limited":
      return "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300"
    case "late":
    case "unavailable":
    case "open_order":
    case "asked":
      return "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-300"
    default:
      return "bg-muted text-muted-foreground"
  }
}

export function segmentText(reply: string): { chars: number; limit: number; segments: number; over: boolean; text: string } {
  const r = calculateSegments(reply)
  const over = r.segments > 1
  return {
    chars: r.length,
    limit: r.singleLimit,
    segments: r.segments,
    over,
    text: `${r.length} / ${r.singleLimit} characters, ${r.segments} segment${r.segments === 1 ? "" : "s"}`,
  }
}

const ERROR_COPY: Record<string, string> = {
  confirm_required: "Turning Text-to-Buy on needs your confirmation. Please confirm and try again.",
  settings_unavailable: "The saved settings could not be read, so nothing was changed. Refresh and try again.",
  rate_limited: "Too many test runs. Please wait a minute and try again.",
  invalid_sender: "Enter a valid Ghana mobile number.",
  invalid_text: "Enter a text between 1 and 500 characters.",
  invalid_outcome: "That outcome filter is not valid.",
  invalid_cursor: "The page marker expired. Refresh the list.",
  not_found: "That message was not found.",
  save_failed: "Settings could not be saved. Please try again.",
  admin_user_required: "This needs a signed-in admin account.",
  "Admin access required": "Admin access required.",
}

export function ttbErrorMessage(code: string | undefined | null): string {
  if (code && Object.prototype.hasOwnProperty.call(ERROR_COPY, code)) return ERROR_COPY[code]
  return "Something went wrong. Please try again."
}

/** Settings fields in the order the page shows them, with the validator's ranges as helper text. */
export const FIELD_LABELS: Record<string, string> = {
  mainEnabled: "Text-to-Buy enabled",
  mainNumber: "Main number",
  replySenderId: "Main line reply sender ID",
  shopReplySenderId: "Shop line reply sender ID",
  aiEnabled: "AI reading enabled",
  staleMinutes: "Stale order minutes",
  promptsPerHour: "Prompts per hour per phone",
  repliesPerHour: "Replies per hour per phone",
  aiReadsPerHour: "AI reads per hour per phone",
  globalPromptsPerMinute: "Prompts per minute (all customers)",
  promptWindowMinutes: "Prompt window minutes",
  quietAlertMinutes: "Quiet-phone alert minutes",
  retentionDays: "Keep messages (days)",
  unclearRepliesEnabled: "Reply to unclear texts",
  globalRepliesPerHour: "Max replies per hour (all senders)",
}
