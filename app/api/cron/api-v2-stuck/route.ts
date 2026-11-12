// Report-only: alerts admins when v2 idempotency claims or v2 data orders sit unfinished
// past 10 minutes. It never changes those rows (see lib/api-v2/stuck.ts).
import { backgroundCron } from "@/lib/cron-background"
import { getAdminClient } from "@/lib/api-v2/store"
import { runStuckSweep } from "@/lib/api-v2/stuck"

export const dynamic = "force-dynamic"
export const maxDuration = 60

async function notify(message: string): Promise<void> {
  try {
    const { notifyAdmins } = await import("@/lib/sms-service")
    await notifyAdmins(message, "api_v2_stuck", undefined, false)
  } catch {
    // alerting must never break the sweep
  }
}

export const GET = backgroundCron("api-v2-stuck", async () => {
  await runStuckSweep(getAdminClient(), new Date(), notify)
})
