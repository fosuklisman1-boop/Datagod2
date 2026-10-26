// Close-tab rules. The leaderboard_close_period RPC (migration 0136) enforces the
// same rules; this only decides what the admin page shows and enables.

import type { PeriodKind } from "./periods"
import { missingPrizes, type PrizeRow } from "./prizes"

const UNIT: Record<PeriodKind, string> = { daily: "day", weekly: "week", monthly: "month", yearly: "year" }

export interface CloseReadiness {
  ended: boolean
  closed: boolean
  rewardsOn: boolean
  /** "dashboard rank 1", ... ranks without an active prize. */
  missing: string[]
  canClose: boolean
  canCloseNoReward: boolean
  /** Explanation under the title, or null. */
  note: string | null
  /** Red validation line, or null. */
  problem: string | null
  /** Helper under the buttons when they are disabled, or null. */
  helper: string | null
}

export function closeReadiness(
  kind: PeriodKind,
  row: { status: string; rewards_enabled: boolean } | null,
  prizes: Pick<PrizeRow, "board" | "rank" | "status">[],
  ended: boolean,
): CloseReadiness {
  const unit = UNIT[kind]
  const closed = !!row && row.status !== "open"
  const rewardsOn = !!row?.rewards_enabled
  const missing = rewardsOn ? missingPrizes(prizes) : []

  let note: string | null = null
  if (closed) note = row!.status === "closed" ? "This period is closed. Its winners and prizes are locked." : "This period was closed without rewards."
  else if (!ended) note = `This ${unit} has not ended yet. You can set prizes now and close it once the ${unit} is over.`

  let problem: string | null = null
  if (!closed && !rewardsOn) problem = "Prizes are off for this period. Switch on “Give prizes” to close with rewards, or close with no reward."
  else if (!closed && missing.length) problem = `Set a prize for: ${missing.join(", ")}`

  return {
    ended,
    closed,
    rewardsOn,
    missing,
    canClose: !closed && ended && rewardsOn && missing.length === 0,
    canCloseNoReward: !closed && ended,
    note,
    problem,
    helper: !closed && !ended ? `Closing is unavailable until the ${unit} has ended.` : null,
  }
}
