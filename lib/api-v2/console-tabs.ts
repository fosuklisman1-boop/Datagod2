// Pure helpers for the admin API console (browser-safe).

export type ConsoleTab = "approvals" | "keys" | "logs"
const TABS: readonly string[] = ["approvals", "keys", "logs"]

/** The first tab: a valid ?tab= wins; otherwise Approvals while anything waits, else Keys. */
export function initialConsoleTab(p: { requested: string | null; waiting: number }): ConsoleTab {
  if (p.requested && TABS.includes(p.requested)) return p.requested as ConsoleTab
  return p.waiting > 0 ? "approvals" : "keys"
}

/** Same rule as the SQL functions: a rejection reason is 3-200 characters after trimming. */
export function rejectReasonOk(reason: string): boolean {
  const n = reason.trim().length
  return n >= 3 && n <= 200
}
