// Release 5 fraud warnings: every 5 minutes (cron-job.org). Does nothing while the alerts switch is off (the scan
// returns []). Report only: it never pauses, blocks or revokes anything.
import { backgroundCron } from "@/lib/cron-background"
import { getAdminClient } from "@/lib/api-v2/store"
import type { RpcClient } from "@/lib/api-v2/approvals"
import { runRiskSweep } from "@/lib/api-v2/risk"

export const dynamic = "force-dynamic"
export const maxDuration = 60

async function notify(message: string): Promise<void> {
  const { notifyAdmins } = await import("@/lib/sms-service")
  await notifyAdmins(message, "api_v2_risk", undefined, false)
}

export const GET = backgroundCron("api-v2-risk", async () => {
  await runRiskSweep(getAdminClient() as unknown as RpcClient, new Date(), notify)
})
