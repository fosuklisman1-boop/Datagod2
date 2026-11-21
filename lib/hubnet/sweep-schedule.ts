/** The Hubnet refund sweep runs on every 10th minute (UTC). Decide this ONCE, at the start of a cron run. */
export function isRefundSweepDue(now: Date): boolean {
  return now.getUTCMinutes() % 10 === 0
}
