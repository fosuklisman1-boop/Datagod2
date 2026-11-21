// The single copy of the scheduled-task "when next?" rule, shared by the scheduled-tasks POST route, the run-ai-tasks
// cron and standing-order creation. The admin route and the cron used to carry two slightly different copies; they differ
// only for weekly tasks, and each caller keeps its old behaviour through `includeToday`:
//   includeToday: true  = the admin POST route's rule: weekly scans today first (offset 0) and may run later today.
//   includeToday: false = the cron's advance rule: weekly always starts tomorrow (offset 1).

export interface NextRunInput {
  schedule_type: string
  run_at_time?: string | null
  run_on_days?: number[] | null
  run_at_timestamp?: string | null
}

export function computeNextRun(task: NextRunInput, opts: { includeToday: boolean }): Date {
  const now = new Date()

  if (task.schedule_type === "once") {
    return task.run_at_timestamp ? new Date(task.run_at_timestamp) : now
  }

  if (task.schedule_type === "hourly") {
    const next = new Date(now)
    next.setUTCMinutes(0, 0, 0)
    next.setUTCHours(next.getUTCHours() + 1)
    return next
  }

  if (task.schedule_type === "daily" && task.run_at_time) {
    const [hh, mm] = task.run_at_time.split(":").map(Number)
    const candidate = new Date(now)
    candidate.setUTCHours(hh, mm, 0, 0)
    if (candidate <= now) candidate.setUTCDate(candidate.getUTCDate() + 1)
    return candidate
  }

  if (task.schedule_type === "weekly" && task.run_at_time && task.run_on_days?.length) {
    const [hh, mm] = task.run_at_time.split(":").map(Number)
    for (let offset = opts.includeToday ? 0 : 1; offset <= 7; offset++) {
      const candidate = new Date(now)
      candidate.setUTCDate(candidate.getUTCDate() + offset)
      candidate.setUTCHours(hh, mm, 0, 0)
      if (!task.run_on_days.includes(candidate.getUTCDay())) continue
      // Admin rule also required the slot to be in the future; the cron rule never looked at today so never needed to.
      if (opts.includeToday ? candidate > now : true) return candidate
    }
  }

  return new Date(now.getTime() + 60 * 60 * 1000)
}
