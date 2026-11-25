// Release 3 request-log retention: daily (cron-job.org). Deletes api_v2_logs rows older than 25 months, at most 5000 per
// call; re-running is harmless (it selects only expired rows). Nothing is old enough to delete until late 2028.
import { backgroundCron } from "@/lib/cron-background"
import { getAdminClient } from "@/lib/api-v2/store"

export const dynamic = "force-dynamic"
export const maxDuration = 60

export const GET = backgroundCron("api-v2-log-retention", async () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (getAdminClient() as any).rpc("api_v2_logs_retention", { p_now: new Date().toISOString() })
  if (error) throw new Error("log retention failed")
  if (Number(data) > 0) console.log(`[api-v2-log-retention] deleted ${Number(data)} rows`)
})
