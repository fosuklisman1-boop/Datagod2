// Release 3 low-balance alerts: every 15 minutes (cron-job.org). Tells a developer once per crossing (the scan disarms the
// row under a lock) on free channels only. Sends nothing for people who never set a threshold.
import { backgroundCron } from "@/lib/cron-background"
import { getAdminClient } from "@/lib/api-v2/store"
import { runBalanceAlertSweep, type AlertDeps } from "@/lib/api-v2/balance-alerts"
import type { RpcLike } from "@/lib/api-v2/dev-dashboard"

export const dynamic = "force-dynamic"
export const maxDuration = 60

function realDeps(): AlertDeps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = getAdminClient() as any
  return {
    contact: async (userId) => {
      const { data } = await db.from("users").select("email, first_name").eq("id", userId).maybeSingle()
      return data ? { email: typeof data.email === "string" && data.email ? data.email : null, name: typeof data.first_name === "string" ? data.first_name : null } : null
    },
    inApp: async (userId, title, message) => {
      const { error } = await db.from("notifications").insert({ user_id: userId, title, message, type: "api_balance_alert", action_url: "/dashboard/wallet", read: false })
      if (error) throw new Error("in-app insert failed")
    },
    push: async (userId, title, message) => {
      const { sendPushToUser } = await import("@/lib/push-service")
      await sendPushToUser(userId, { title, body: message, data: { url: "/dashboard/wallet" } })
    },
    email: async (to, subject, text, html) => {
      const { sendEmail } = await import("@/lib/email-service")
      const r = await sendEmail({ to: [{ email: to.email, ...(to.name ? { name: to.name } : {}) }], subject, htmlContent: html, textContent: text, type: "api_balance_alert" })
      if (!r.success) throw new Error("email failed")
    },
  }
}

export const GET = backgroundCron("api-v2-balance-alerts", async () => {
  await runBalanceAlertSweep(getAdminClient() as unknown as RpcLike, new Date(), realDeps())
})
