import { TITLE_PREFIX, type JobSpec } from "./jobs"
import type { JobSchedule } from "./schedule"

export type ExistingJob = {
  jobId: number
  title: string
  url: string
  enabled: boolean
  schedule?: JobSchedule
}

export type Action = {
  kind: "create" | "update" | "skip"
  spec: JobSpec
  jobId?: number
  reason?: string
}

function sameSchedule(a: JobSchedule | undefined, b: JobSchedule): boolean {
  if (!a) return false
  const keys: (keyof JobSchedule)[] = ["hours", "mdays", "minutes", "months", "wdays"]
  return keys.every((k) => JSON.stringify(a[k]) === JSON.stringify(b[k]))
}

/**
 * Diffs desired specs against the jobs already in the cron-job.org account.
 * A job is matched by exact URL, and only if it lives on `host` - jobs for
 * other sites sharing the account are never matched or touched.
 * - no match -> create
 * - match not yet owned (title lacks the dg: prefix) -> update (adopt: set title + auth header)
 * - owned match whose schedule drifted -> update
 * - owned match, same schedule -> skip (so a re-run costs no writes)
 */
export function planActions(specs: JobSpec[], existing: ExistingJob[], host: string): Action[] {
  const base = host.replace(/\/+$/, "")
  const mine = existing.filter((e) => e.url.startsWith(base + "/"))
  return specs.map((spec): Action => {
    const match = mine.find((e) => e.url === spec.url)
    if (!match) return { kind: "create", spec }
    if (!match.title.startsWith(TITLE_PREFIX)) {
      return { kind: "update", spec, jobId: match.jobId, reason: "adopt existing job" }
    }
    if (!sameSchedule(match.schedule, spec.schedule)) {
      return { kind: "update", spec, jobId: match.jobId, reason: "schedule differs" }
    }
    return { kind: "skip", spec, jobId: match.jobId, reason: "up to date" }
  })
}

export type BudgetState = { day: string; used: number }

/** Daily API-call budget guard (cron-job.org allows 100/day; we stop at 80 to leave headroom). */
export function checkBudget(
  state: BudgetState | null,
  today: string,
  needed: number,
  cap = 80,
): { ok: boolean; state: BudgetState } {
  const used = state && state.day === today ? state.used : 0
  if (used + needed > cap) return { ok: false, state: { day: today, used } }
  return { ok: true, state: { day: today, used: used + needed } }
}
