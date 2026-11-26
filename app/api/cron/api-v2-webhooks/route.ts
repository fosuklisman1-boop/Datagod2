// Release 6 webhooks: every minute (cron-job.org). Scans for new order events, then sends due events through the SSRF
// guard and records each attempt. Does nothing while the admin switch is off (the SQL scan and claim return nothing).
// Once an hour (minute 7) it also prunes events/attempts older than 30 days.
import { backgroundCron } from "@/lib/cron-background"
import { getAdminClient } from "@/lib/api-v2/store"
import { runWebhookCycle, type RpcClientLike } from "@/lib/api-v2/webhooks/worker"
import { realCycleDeps } from "@/lib/api-v2/webhooks/real-deps"

export const dynamic = "force-dynamic"
export const maxDuration = 60

export const GET = backgroundCron("api-v2-webhooks", async () => {
  const client = getAdminClient() as unknown as RpcClientLike
  const out = await runWebhookCycle(client, realCycleDeps)
  if (out.sent || out.scanned) console.log(`[api-v2-webhooks] scanned=${out.scanned} sent=${out.sent} delivered=${out.delivered} failed=${out.failed}`)
  if (new Date().getUTCMinutes() === 7) {
    const r = await client.rpc("api_v2_webhook_retention", { p_now: new Date().toISOString() })
    if (r.error) console.error("[api-v2-webhooks] retention failed")
  }
})
