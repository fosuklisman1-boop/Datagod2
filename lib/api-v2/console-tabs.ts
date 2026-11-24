// Pure helpers for the admin API console (browser-safe).

export type ConsoleTab = "overview" | "approvals" | "developers" | "keys" | "logs" | "services" | "announcements" | "report" | "legacy"

/** Order and labels of the admin API console tabs (spec section 4). Old ?tab=approvals|keys|logs links keep working. */
export const CONSOLE_TABS: readonly { id: ConsoleTab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "approvals", label: "Approvals" },
  { id: "developers", label: "Developers" },
  { id: "keys", label: "Keys" },
  { id: "logs", label: "Logs" },
  { id: "services", label: "Services and status" },
  { id: "announcements", label: "Announcements" },
  { id: "report", label: "Report" },
  { id: "legacy", label: "Legacy v1 (ends 30 Nov 2026)" },
]

/** The first tab: a valid ?tab= wins; otherwise Approvals while anything waits, else Overview. */
export function initialConsoleTab(p: { requested: string | null; waiting: number }): ConsoleTab {
  const hit = CONSOLE_TABS.find((t) => t.id === p.requested)
  if (hit) return hit.id
  return p.waiting > 0 ? "approvals" : "overview"
}

/** Bars for the 30-day trend: one per day, scaled to the busiest day; the failed part never exceeds the bar. */
export function trendBars(points: { day: string; requests: number; failed: number }[], height: number): { x: number; h: number; failedH: number; label: string }[] {
  if (points.length === 0) return []
  const max = Math.max(1, ...points.map((p) => Math.max(0, p.requests)))
  return points.map((p, i) => {
    const total = Math.max(0, p.requests)
    const failed = Math.min(Math.max(0, p.failed), total)
    return {
      x: i,
      h: Math.round((total / max) * height * 10) / 10,
      failedH: Math.round((failed / max) * height * 10) / 10,
      label: `${p.day}: ${p.requests} requests, ${p.failed} failed`,
    }
  })
}

/** Same rule as the SQL functions: a rejection reason is 3-200 characters after trimming. */
export function rejectReasonOk(reason: string): boolean {
  const n = reason.trim().length
  return n >= 3 && n <= 200
}
