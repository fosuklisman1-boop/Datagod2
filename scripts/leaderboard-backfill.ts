/**
 * Leaderboard backfill
 *
 * Fills leaderboard_daily_totals for history, one calendar month per RPC call,
 * after migrations/0133_leaderboard_engine.sql (and 0134 indexes) are applied.
 * Safe to re-run: each call rebuilds its days from the order tables.
 *
 *   npx tsx --env-file=.env.local scripts/leaderboard-backfill.ts 2024-01-01
 *   npx tsx --env-file=.env.local scripts/leaderboard-backfill.ts 2024-01-01 2024-12-31
 *
 * The end day defaults to today (Africa/Accra).
 */

import { createClient } from "@supabase/supabase-js"
import { accraDay, isDay, monthChunks } from "@/lib/leaderboard/periods"
import { refreshLeaderboardTotals } from "@/lib/leaderboard/service"

async function main() {
  const [from, to = accraDay(new Date())] = process.argv.slice(2)
  if (!isDay(from) || !isDay(to) || from > to) {
    console.error("Usage: scripts/leaderboard-backfill.ts <from YYYY-MM-DD> [to YYYY-MM-DD]")
    process.exit(1)
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    console.error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set")
    process.exit(1)
  }
  const db = createClient(url, key)

  let total = 0
  for (const chunk of monthChunks({ start: from, end: to })) {
    const rows = await refreshLeaderboardTotals(db, chunk)
    total += rows
    console.log(`${chunk.start} .. ${chunk.end}: ${rows} rows`)
  }
  console.log(`Done: ${total} daily total rows`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
