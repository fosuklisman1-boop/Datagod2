import { looksLikeOrderPrompt } from "./prompt-order-detect"

export interface PauseTask {
  id: string
  user_id: string
  schedule_type: string
  prompt: string
  is_active: boolean
  context: string
  standing_order: unknown | null
}

export interface PauseDeps {
  /** Set is_active=false for these ids (caller passes at most 100). */
  deactivate(ids: string[]): Promise<void>
  push(userId: string, payload: { title: string; body: string; data: { url: string } }): Promise<{ sent: number }>
}

export interface PauseResult { matched: number; paused: number; notified: number; pushFailures: number }

export const CHUNK_SIZE = 100
export const PUSH_TITLE = "Your scheduled order is paused"
export const PUSH_BODY = "Data orders now need your confirmation. Tap to set it up again."

/** Active dashboard tasks with no standing order whose prompt orders data. Tasks with a standing order are new-style: never touched. */
export function selectPromptOrderTasks(rows: PauseTask[]): PauseTask[] {
  return rows.filter(
    r => r.is_active === true && r.context === "dashboard" && r.standing_order == null && looksLikeOrderPrompt(r.prompt ?? ""),
  )
}

function maskDigits(digits: string): string {
  return digits.slice(0, 3) + "*".repeat(Math.max(digits.length - 5, 0)) + digits.slice(-2)
}

/** First 60 chars of a prompt with phone-like digit runs (9+ digits, optional space/dash separators) and emails masked. */
export function maskPrompt(prompt: string): string {
  const masked = (prompt ?? "")
    .replace(/\S+@\S+/g, "***@***")
    .replace(/\+?\d(?:[ -]?\d){8,}/g, m => maskDigits(m.replace(/\D/g, "")))
    .replace(/\s+/g, " ")
  return masked.slice(0, 60)
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/** One entry per owner, linking to their first affected task. */
export function planNotifications(tasks: PauseTask[]): { userId: string; url: string }[] {
  const seen = new Map<string, string>()
  for (const t of tasks) if (!seen.has(t.user_id)) seen.set(t.user_id, `/dashboard?ai=reapprove&task=${t.id}`)
  return [...seen].map(([userId, url]) => ({ userId, url }))
}

/** Dry run (apply=false) touches nothing. Apply pauses in chunks, then pushes each owner once. */
export async function runPause(tasks: PauseTask[], apply: boolean, deps: PauseDeps): Promise<PauseResult> {
  const result: PauseResult = { matched: tasks.length, paused: 0, notified: 0, pushFailures: 0 }
  if (!apply) return result
  for (const ids of chunk(tasks.map(t => t.id), CHUNK_SIZE)) {
    await deps.deactivate(ids)
    result.paused += ids.length
  }
  for (const { userId, url } of planNotifications(tasks)) {
    try {
      const r = await deps.push(userId, { title: PUSH_TITLE, body: PUSH_BODY, data: { url } })
      if (r.sent > 0) result.notified++
      else result.pushFailures++
    } catch {
      result.pushFailures++
    }
  }
  return result
}
