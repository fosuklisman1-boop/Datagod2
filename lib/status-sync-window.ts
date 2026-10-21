// Which provider-tracking rows the per-provider status syncs (app/api/cron/sync-mtn-status/<provider>)
// should poll on a normal run.
//
// Those syncs select pending/processing rows oldest-first and wait 1-2 s between provider calls. Rows
// that never resolve (hundreds, some from June/July) sat at the front of the queue, so every run
// re-polled the same dead rows - ~45 hours/day of function time - and the newest orders waited behind
// them. A normal run now only looks at orders from the last SYNC_WINDOW_DAYS days; a short sweep each
// day (03:00-03:04 UTC, several consecutive runs) still reaches back through the older ones, so nothing
// is abandoned - it is just checked daily instead of every minute.

export const SYNC_WINDOW_DAYS = 7

const DAY_MS = 24 * 60 * 60 * 1000
const SWEEP_HOUR_UTC = 3
const SWEEP_MINUTES = 5

/** True during the daily sweep (03:00-03:04 UTC). */
export function isDailySweep(now: Date = new Date()): boolean {
  return now.getUTCHours() === SWEEP_HOUR_UTC && now.getUTCMinutes() < SWEEP_MINUTES
}

/** Earliest created_at a sync should poll right now (ISO string for .gte("created_at", ...)). */
export function syncWindowStartIso(now: Date = new Date()): string {
  if (isDailySweep(now)) return new Date(Date.UTC(2000, 0, 1)).toISOString()
  return new Date(now.getTime() - SYNC_WINDOW_DAYS * DAY_MS).toISOString()
}
