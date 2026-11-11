// Pure display helpers for the Send & Claim admin page. Client-safe: no server imports, no I/O.

export const ADMIN_STATUSES = ["pending", "claimed", "flagged", "voided", "unparsed", "rejected_sender"] as const
export type AdminStatus = (typeof ADMIN_STATUSES)[number]

export const STATUS_LABELS: Record<string, string> = {
  pending: "Pending",
  claimed: "Claimed",
  flagged: "Flagged",
  voided: "Voided",
  unparsed: "Unparsed",
  rejected_sender: "Rejected sender",
}

const REASON_LABELS: Record<string, string> = {
  first_claim: "first claim",
  amount_mismatch: "amount mismatch",
  txid_regression: "old transaction ID",
  balance_repeat: "repeated balance",
  above_max: "above maximum",
  above_review_threshold: "large amount",
  daily_cap: "daily cap reached",
  too_many_attempts: "too many wrong attempts",
  intake_check_error: "check failed",
  auto_credit_error: "auto-credit error",
}

// Reasons that only mean "an admin should look once": approving is the normal outcome.
const REVIEW_ONLY = new Set(["first_claim", "above_review_threshold", "daily_cap"])

export function flagReasonLabel(reason: string): string {
  return REASON_LABELS[reason] ?? "other"
}

export function flagReasonsText(reasons: string[] | null | undefined): string {
  if (!Array.isArray(reasons)) return ""
  return reasons.map(flagReasonLabel).join(", ")
}

export function isReviewOnlyFlag(reasons: string[] | null | undefined): boolean {
  return Array.isArray(reasons) && reasons.length > 0 && reasons.every((r) => REVIEW_ONLY.has(r))
}

export type RowAction = "void" | "restore" | "unflag" | "credit" | "assign"
export type RowActionSpec = { action: RowAction; label: string; primary?: boolean; hint?: string }

const UNFLAG_HINT = "Unflag only releases the row; it will just re-flag on the next claim attempt."

export function rowActions(status: string, flagReasons: string[] | null | undefined): RowActionSpec[] {
  switch (status) {
    case "pending":
      // A pending row whose SMS named no live code can still be credited to the right user by hand.
      return [
        { action: "void", label: "Void" },
        { action: "assign", label: "Assign to user" },
      ]
    case "unparsed":
      return [
        { action: "void", label: "Void" },
        { action: "assign", label: "Assign to user" },
      ]
    case "voided":
      return [{ action: "restore", label: "Restore" }]
    case "flagged": {
      const reviewOnly = isReviewOnlyFlag(flagReasons)
      return [
        { action: "credit", label: "Approve & credit", primary: reviewOnly },
        { action: "assign", label: "Assign to user" },
        reviewOnly ? { action: "unflag", label: "Unflag", hint: UNFLAG_HINT } : { action: "unflag", label: "Unflag" },
      ]
    }
    default:
      return []
  }
}

export function actionNeedsReason(action: RowAction): boolean {
  return action === "unflag" || action === "credit" || action === "assign"
}

/** Assign asks for the sent amount only when the row has none (an unreadable SMS); otherwise the SMS amount is used. */
export function actionNeedsAmount(action: RowAction, rowAmount: number | string | null | undefined): boolean {
  return action === "assign" && rowAmount == null
}

/** "GHS 12.30"; "-" when the value is missing or not a number. */
export function formatGhs(v: number | string | null | undefined): string {
  if (v === null || v === undefined || v === "") return "-"
  const n = typeof v === "number" ? v : Number(v)
  if (!Number.isFinite(n)) return "-"
  return `GHS ${n.toFixed(2)}`
}

const ERROR_COPY: Record<string, string> = {
  no_linked_session: "No linked payment session, so there is no user to credit. Use Assign to user instead.",
  invalid_state: "This row changed in the meantime. Refresh and check its status.",
  conflict: "Another change was made at the same time. Refresh and try again.",
  not_found: "That record was not found.",
  no_wallet: "That user has no wallet yet.",
  unknown_user: "No user found with that ID.",
  reason_required: "A reason (1 to 200 characters) is required.",
  invalid_amount: "Enter a valid amount in GHS (up to 2 decimals).",
  bad_input: "That request was not valid.",
  credit_failed: "Crediting failed. Nothing was changed; try again.",
  unflag_failed: "Unflagging failed. Try again.",
  settings_unavailable: "Settings could not be loaded, so saving is disabled to avoid resetting them.",
  save_failed: "Settings could not be saved. Try again.",
  mtn_account_required: "Add an MTN account number before turning Send & Claim on.",
  run_not_saved: "The check ran but the run was not saved. Use the missing IDs shown below now.",
  unknown_column: "That column is not in the CSV.",
  invalid_csv: "The CSV could not be read.",
  csv_too_large: "The CSV is too large (5 MB maximum).",
  invalid_column: "Choose the transaction ID column.",
  invalid_period: "Choose a valid start and end date (start must not be after end).",
  period_too_long: "The period can be at most 62 days.",
  invalid_id: "That ID is not valid.",
  invalid_action: "That action is not allowed.",
  invalid_transaction: "That transaction is not valid.",
  admin_user_required: "Sign in as an admin user to do this.",
  "Admin access required": "Sign in as an admin to use this page.",
  unavailable: "The service is unavailable right now. Try again shortly.",
  server_error: "The server hit an error. Try again.",
  invalid_setting: "One of the settings is not valid.",
  bad_setting: "A Send & Claim setting is invalid — fix it in Settings",
  Unauthorized: "Your session expired — sign in again.",
  "Invalid token": "Your session expired — sign in again.",
}

export const FIELD_LABELS: Record<string, string> = {
  enabled: "Enabled",
  accounts: "Payment accounts",
  accountName: "Account name",
  feeCustomerPercent: "Customer fee",
  feeDealerPercent: "Dealer fee",
  minNet: "Minimum credit",
  maxSent: "Maximum per payment",
  senderAllowlist: "SMS sender allow-list",
  regressionThreshold: "Old-ID threshold",
  reviewThreshold: "Review threshold",
  dailyCap: "Daily cap",
}

export function adminErrorMessage(code: string | undefined | null): string {
  if (code && Object.prototype.hasOwnProperty.call(ERROR_COPY, code)) return ERROR_COPY[code]
  return "Something went wrong. Please try again."
}

/** Header cells of the first CSV line (simple split; strips BOM, quotes, blanks). */
export function csvHeaderColumns(csv: string): string[] {
  const first = csv.replace(/^﻿/, "").split(/\r?\n/, 1)[0] ?? ""
  return first
    .split(",")
    .map((c) => c.trim().replace(/^"(.*)"$/, "$1").trim())
    .filter((c) => c.length > 0)
}

/** Inclusive number of days between two YYYY-MM-DD dates, or null if either is invalid. */
export function inclusiveSpanDays(start: string, end: string): number | null {
  const ok = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00.000Z`))
  if (!ok(start) || !ok(end)) return null
  return Math.round((Date.parse(`${end}T00:00:00.000Z`) - Date.parse(`${start}T00:00:00.000Z`)) / 86_400_000) + 1
}
