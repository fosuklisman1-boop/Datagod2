// Pure state -> view mapping for the AI confirm card. The card never decides an outcome: this only translates what the
// server said (status + outcome codes) into text and which buttons to show. No React, no network, no clock reads.

export type LoadError = "not_found" | "unauthorized" | "rate_limited" | "unavailable" | "network"

export interface CardViewState {
  /** Set when the first GET failed and no server state is known. */
  loadError?: LoadError
  /** `already_done` is the server's replay of a used draft; `finalStatus` then says succeeded or partial. */
  status: string
  finalStatus?: string
  outcome: Record<string, unknown> | null
  display: unknown
  expires_at: string
  warnings?: string[]
}

export type CardVariant = "load_error" | "pending" | "executing" | "succeeded" | "partial" | "failed" | "unknown" | "expired" | "superseded" | "cancelled"

export interface CardView {
  variant: CardVariant
  title: string
  lines: Array<{ label: string; value: string }>
  showConfirm: boolean
  showCancel: boolean
  showCheckAgain: boolean
  /** Re-run the GET (load errors only). */
  showRetry: boolean
  showPrepareAgain: boolean
  greyed: boolean
  message: string | null
  countdownText: string | null
  /** Per-item lines for a partial result (expandable in the card). */
  items: string[]
  /** Set for insufficient_balance. */
  topUpHref: string | null
  warnings: string[]
  /** Admin cards only (null otherwise). */
  risk: AdminRisk | null
  summary: string | null
  /** "This cannot be undone." on danger cards. */
  dangerNote: string | null
  secretFields: SecretField[]
  /** A safe /admin link (unknown outcome of an admin card), else null. */
  pageLink: string | null
}

export type AdminRisk = "normal" | "money" | "danger"
export interface SecretField { name: string; label: string; min: number; max: number }

export const DANGER_NOTE = "This cannot be undone."

/** Card border classes per risk: navy brand accent (primary), amber for money, red for danger. */
export function adminCardTone(risk: AdminRisk): string {
  return risk === "danger" ? "border-destructive/60" : risk === "money" ? "border-amber-500/60" : "border-primary/30"
}

const SAFE_ADMIN_LINK = /^\/admin(?:[/?#]|$)[^\s\\]*$/

/** Only an /admin path is ever linked. The value is server data and is treated as untrusted. */
export function safePageLink(v: unknown): string | null {
  return typeof v === "string" && v.length <= 300 && SAFE_ADMIN_LINK.test(v) ? v : null
}

function readAdminDisplay(display: unknown) {
  const d = (display && typeof display === "object" ? display : null) as Record<string, unknown> | null
  if (!d || d.kind !== "admin_route") return null
  const risk: AdminRisk = d.risk === "danger" || d.risk === "money" ? d.risk : "normal"
  const secretFields: SecretField[] = (Array.isArray(d.secretFields) ? d.secretFields : []).flatMap((f) => {
    const o = (f && typeof f === "object" ? f : {}) as Record<string, unknown>
    if (typeof o.name !== "string" || !/^[A-Za-z0-9_]{1,64}$/.test(o.name)) return []
    const min = typeof o.min === "number" && Number.isFinite(o.min) && o.min >= 1 ? Math.floor(o.min) : 1
    const max = typeof o.max === "number" && Number.isFinite(o.max) && o.max >= min ? Math.floor(o.max) : 256
    return [{ name: o.name, label: typeof o.label === "string" && o.label.trim() ? o.label.trim() : o.name, min, max }]
  })
  return {
    title: typeof d.pageTitle === "string" && d.pageTitle.trim() ? d.pageTitle.trim() : "Confirm action",
    summary: typeof d.summary === "string" && d.summary.trim() ? d.summary.trim() : null,
    risk,
    secretFields,
  }
}

/** Confirm stays disabled until every secret box meets its min (and does not exceed max). */
export function secretsReady(fields: SecretField[], values: Record<string, string>): boolean {
  return fields.every((f) => {
    const v = values[f.name]
    return typeof v === "string" && v.length >= f.min && v.length <= f.max
  })
}

/** The confirm request body: only the declared names. Null when there is nothing secret to send. */
export function buildConfirmSecrets(fields: SecretField[], values: Record<string, string>): { secrets: Record<string, string> } | null {
  if (fields.length === 0) return null
  const secrets: Record<string, string> = {}
  for (const f of fields) secrets[f.name] = values[f.name] ?? ""
  return { secrets }
}

/** Message for a failed confirm ("" = use the generic one). Server text is used only for the two secret codes. */
export function confirmErrorMessage(status: number, body: unknown): string {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>
  if (status === 413) return "That value is too long."
  if (status === 400 && (b.code === "missing_secret" || b.code === "bad_secret")) {
    return typeof b.error === "string" && b.error.trim() ? b.error.trim().slice(0, 200) : "Please fill in the secure box."
  }
  return ""
}

export const TOP_UP_HREF = "/dashboard/wallet"
export const UNKNOWN_MESSAGE = "We couldn't confirm the result."

const WARNING_TEXT: Record<string, string> = {
  duplicate_recent: "You recently ordered this for the same number.",
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
const pad = (n: number) => String(n).padStart(2, "0")

/** "Sat 22 Nov, 08:00". Ghana local time is UTC, so the UTC fields are the local ones. */
export function formatGhanaTime(iso: string): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return iso
  const d = new Date(t)
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
}

const ISO_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/g
const humanizeTimes = (s: string) => s.replace(ISO_RE, (m) => (/(Z|[+-]\d{2}:?\d{2})$/.test(m) ? formatGhanaTime(m) : formatGhanaTime(m + "Z")))

const ghs = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? `GHS ${n.toFixed(2)}` : null)

const BALANCE_LABEL = /^balance( before| after)?$/i

function readDisplay(display: unknown): { title: string; lines: Array<{ label: string; value: string }> } {
  const d = (display && typeof display === "object" ? display : {}) as Record<string, unknown>
  let lines = Array.isArray(d.lines)
    ? (d.lines as unknown[])
        .filter((l): l is { label: unknown; value: unknown } => !!l && typeof l === "object")
        .map((l) => ({ label: String(l.label ?? ""), value: humanizeTimes(String(l.value ?? "")) }))
    : []
  // One "Balance before -> after" line replaces any server balance lines.
  const before = ghs(d.balanceBefore)
  const after = ghs(d.balanceAfter)
  if (before && after) {
    const merged = { label: "Balance", value: `${before} → ${after}` }
    const at = lines.findIndex((l) => BALANCE_LABEL.test(l.label.trim()))
    const rest = lines.filter((l) => !BALANCE_LABEL.test(l.label.trim()))
    lines = at >= 0 ? [...rest.slice(0, at), merged, ...rest.slice(at)] : [...rest, merged]
  }
  return { title: typeof d.title === "string" && d.title ? d.title : "Confirm action", lines }
}

function countdown(expiresAt: string, nowMs: number): { text: string; expired: boolean } {
  const ms = Date.parse(expiresAt) - nowMs
  if (!Number.isFinite(ms) || ms <= 0) return { text: "Expired", expired: true }
  const total = Math.ceil(ms / 1000)
  return { text: `Expires in ${Math.floor(total / 60)}:${pad(total % 60)}`, expired: false }
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null)

function failureMessage(o: Record<string, unknown>): { message: string; prepareAgain: boolean; topUp?: boolean } {
  const code = str(o.code)
  switch (code) {
    case "insufficient_balance":
      return { message: "Your wallet balance is too low for this. Top up and try again.", prepareAgain: false, topUp: true }
    case "price_changed": {
      const was = ghs(o.oldPrice)
      const now = ghs(o.newPrice)
      return { message: was && now ? `The price changed from ${was} to ${now}. Nothing was charged.` : "The price changed. Nothing was charged.", prepareAgain: true }
    }
    case "schedule_not_supported":
      return { message: "Scheduled orders can't be confirmed from chat yet. Please use the schedule page.", prepareAgain: false }
    case "not_placed":
      return { message: "The order was not placed and you were not charged. Prepare it again.", prepareAgain: true }
    case "state_changed":
      return { message: "This changed since the card was made — prepare it again.", prepareAgain: true }
    case "not_applied":
      return { message: "The change was not applied. It is safe to prepare it again.", prepareAgain: true }
    case "admin_required":
      return { message: "This action needs an admin account.", prepareAgain: false }
    case "endpoint_error":
      return { message: "Something went wrong on our side. Check your history before trying again.", prepareAgain: false }
    case "revalidate_error":
      return { message: str(o.message) ?? "Something went wrong checking this action. Prepare it again.", prepareAgain: true }
    default:
      return { message: str(o.message) ?? "This could not be completed.", prepareAgain: false }
  }
}

function unknownMessage(o: Record<string, unknown>): string {
  switch (str(o.code)) {
    case "still_checking":
      return "Still checking. Try again in a few minutes."
    case "check_wallet_history":
      return "We couldn't tell if this was applied. Check the user's wallet history."
    case "recheck_failed":
      return "We couldn't check just now. Try again in a moment."
    default:
      return UNKNOWN_MESSAGE
  }
}

function partialItems(o: Record<string, unknown>): string[] {
  const results = Array.isArray(o.results) ? (o.results as Array<Record<string, unknown>>) : []
  return results.map((r) => {
    if (typeof r.table === "string") return `${r.table}: ${Number(r.count)} of ${Number(r.total)} updated`
    const id = typeof r.id === "string" ? r.id.slice(0, 8) : "item"
    return `${id}: ${r.ok === true ? "done" : "not applied"}`
  })
}

/** Card state for a draft opened from a link: the stored server state (GET body), never an assumed "pending". */
export function linkedCardState(s: { status: string; outcome?: Record<string, unknown> | null; display: unknown; expires_at: string }): CardViewState {
  return { status: s.status, outcome: s.outcome ?? null, display: s.display, expires_at: s.expires_at, warnings: [] }
}

export function draftCardView(state: CardViewState, nowMs: number): CardView {
  const read = readDisplay(state.display)
  const admin = readAdminDisplay(state.display)
  const title = admin ? admin.title : read.title
  const lines = read.lines
  const o = state.outcome ?? {}
  const warnings = (state.warnings ?? []).map((w) => WARNING_TEXT[w]).filter((w): w is string => !!w)
  const view: CardView = {
    variant: "pending",
    title,
    lines,
    showConfirm: false,
    showCancel: false,
    showCheckAgain: false,
    showRetry: false,
    showPrepareAgain: false,
    greyed: false,
    message: null,
    countdownText: null,
    items: [],
    topUpHref: null,
    warnings: [],
    risk: admin ? admin.risk : null,
    summary: admin ? admin.summary : null,
    dangerNote: admin?.risk === "danger" ? DANGER_NOTE : null,
    secretFields: admin ? admin.secretFields : [],
    pageLink: null,
  }

  if (state.loadError) {
    const e = state.loadError
    const message =
      e === "not_found" ? "This card is no longer available." : e === "unauthorized" ? "Please sign in again." : "We couldn't load this card. Please try again."
    return { ...view, variant: "load_error", greyed: e === "not_found", message, showRetry: e !== "not_found" && e !== "unauthorized" }
  }

  const replay = state.status === "already_done"
  // A replay without proof of how it ended is never shown as success.
  const status = replay ? (state.finalStatus ?? "unknown") : state.status

  switch (status) {
    case "pending": {
      const c = countdown(state.expires_at, nowMs)
      if (c.expired) return { ...view, variant: "expired", greyed: true, showPrepareAgain: true, message: "This card has expired." }
      return { ...view, variant: "pending", showConfirm: true, showCancel: true, countdownText: c.text, warnings }
    }
    case "executing":
      return { ...view, variant: "executing", message: "Working on it..." }
    case "succeeded": {
      const extra: Array<{ label: string; value: string }> = []
      if (str(o.order_code)) extra.push({ label: "Order", value: String(o.order_code) })
      const bal = ghs(o.new_balance)
      if (bal) extra.push({ label: "New balance", value: bal })
      return {
        ...view,
        variant: "succeeded",
        lines: [...lines, ...extra],
        message:
          str(o.code) === "scheduled"
            ? "Scheduled. It will run automatically; no order was placed yet."
            : replay || o.alreadyPlaced === true || o.alreadyApplied === true
              ? "Already done. This was completed before."
              : "Done.",
      }
    }
    case "partial": {
      const applied = Number(o.applied) || 0
      const total = Number(o.total) || 0
      const skipped = Number(o.skipped) || 0
      const failed = Math.max(total - applied, 0)
      return {
        ...view,
        variant: "partial",
        message: `${applied} done · ${failed} failed${skipped ? ` · ${skipped} skipped` : ""}`,
        items: partialItems(o),
      }
    }
    case "failed": {
      const f = failureMessage(o)
      return { ...view, variant: "failed", message: f.message, showPrepareAgain: f.prepareAgain, topUpHref: f.topUp ? TOP_UP_HREF : null }
    }
    case "unknown":
      // An admin route has no generic recheck: the page itself is the truth, so link to it instead.
      if (admin) return { ...view, variant: "unknown", message: unknownMessage(o), pageLink: safePageLink(o.pageLink) }
      return { ...view, variant: "unknown", message: unknownMessage(o), showCheckAgain: true }
    case "expired":
      return { ...view, variant: "expired", greyed: true, showPrepareAgain: true, message: "This card has expired." }
    case "superseded":
      return { ...view, variant: "superseded", greyed: true, message: "Replaced by a newer card" }
    case "cancelled":
      return { ...view, variant: "cancelled", greyed: true, message: "Cancelled" }
    default:
      return { ...view, variant: "unknown", message: UNKNOWN_MESSAGE, showCheckAgain: true }
  }
}
