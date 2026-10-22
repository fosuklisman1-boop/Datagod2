/**
 * Converts the 5-field cron expressions used in vercel.json into the
 * array-based schedule format of the cron-job.org REST API (-1 = every).
 * Supports only what vercel.json uses: a star, a star-slash-N step (minutes
 * only) and a single integer in the minute/hour fields. Everything else
 * throws so nothing is silently mis-scheduled.
 */
export type JobSchedule = {
  timezone: "UTC"
  hours: number[]
  mdays: number[]
  minutes: number[]
  months: number[]
  wdays: number[]
}

const EVERY = [-1]

function parseField(field: string, max: number, allowStep: boolean): number[] {
  if (field === "*") return EVERY
  const step = /^\*\/(\d+)$/.exec(field)
  if (step && allowStep) {
    const n = Number(step[1])
    if (n < 1 || n > max) throw new Error(`unsupported step: ${field}`)
    const out: number[] = []
    for (let v = 0; v <= max; v += n) out.push(v)
    return out
  }
  if (/^\d+$/.test(field)) {
    const v = Number(field)
    if (v > max) throw new Error(`unsupported value: ${field}`)
    return [v]
  }
  throw new Error(`unsupported cron field: ${field}`)
}

export function cronToSchedule(expr: string): JobSchedule {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) throw new Error(`unsupported cron expression: ${expr}`)
  const [min, hour, mday, month, wday] = parts
  if (mday !== "*" || month !== "*" || wday !== "*") {
    throw new Error(`unsupported cron expression (day/month/weekday must be *): ${expr}`)
  }
  return {
    timezone: "UTC",
    hours: parseField(hour, 23, false),
    mdays: EVERY,
    minutes: parseField(min, 59, true),
    months: EVERY,
    wdays: EVERY,
  }
}
