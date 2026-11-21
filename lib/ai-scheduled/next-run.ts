// The single copy of the scheduled-task "when next?" rule, shared by the scheduled-tasks POST route, the run-ai-tasks
// cron and standing-order creation. This is the cron's version moved verbatim: the admin route used to carry a second,
// slightly different copy (weekly scanned offsets 0..7 and allowed "later today"); weekly now always starts tomorrow.

export interface NextRunInput {
  schedule_type: string
  run_at_time?: string | null
  run_on_days?: number[] | null
  run_at_timestamp?: string | null
}

export function computeNextRun(task: NextRunInput): Date {
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
    for (let offset = 1; offset <= 7; offset++) {
      const candidate = new Date(now)
      candidate.setUTCDate(candidate.getUTCDate() + offset)
      candidate.setUTCHours(hh, mm, 0, 0)
      if (task.run_on_days.includes(candidate.getUTCDay())) return candidate
    }
  }

  return new Date(now.getTime() + 60 * 60 * 1000)
}
