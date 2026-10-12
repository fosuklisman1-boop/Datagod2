import { clipSms } from "./html"
import type { ChannelName, ChannelResult, FlowDef, NotifierDeps, Outcome, Recipient, Target } from "./types"

const CHANNEL_TIMEOUT_MS = 8000
const LOOKUP_TIMEOUT_MS = 5000

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
  })
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer))
}

async function run(channel: ChannelName, fn: () => Promise<unknown>): Promise<ChannelResult> {
  try {
    await withTimeout(Promise.resolve().then(fn), CHANNEL_TIMEOUT_MS, channel)
    return { channel, status: "sent" }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    console.error(`[ADMIN-ACTION] ${channel} failed: ${detail}`)
    return { channel, status: "failed", detail }
  }
}

/** One summary line per call: channel names only, never contact data or message text. */
function logSummary(flow: string, what: string, reference: string | undefined, results: ChannelResult[]) {
  const names = (st: ChannelResult["status"]) => results.filter((r) => r.status === st).map((r) => r.channel).join(",") || "-"
  console.log("[ADMIN-ACTION]", flow, what, reference ?? "-", `sent=${results.filter((r) => r.status === "sent").length} skipped=${names("skipped")} failed=${names("failed")}`)
}

const skipped = (channel: ChannelName, detail: string): Promise<ChannelResult> =>
  Promise.resolve({ channel, status: "skipped", detail })

export function createNotifier(registry: Record<string, FlowDef<any>>, deps: NotifierDeps) {
  async function alertAdminsOfRequest(flow: string, ctx: unknown): Promise<ChannelResult[]> {
    try {
      const def = registry[flow]
      if (!def) {
        console.error(`[ADMIN-ACTION] unknown flow "${flow}"`)
        return []
      }
      const alert = def.adminAlert(ctx)
      const results = await Promise.all([
        run("admin_email", () => deps.notifyAdminsEmail(alert.subject, alert.html)),
        run("admin_push", () => deps.notifyAdminsPush({ title: alert.pushTitle, body: alert.pushBody, data: { url: alert.url } })),
      ])
      logSummary(flow, "alert", undefined, results)
      return results
    } catch (err) {
      console.error(`[ADMIN-ACTION] alert for "${flow}" failed:`, err instanceof Error ? err.message : err)
      return []
    }
  }

  async function notifyUserOfOutcome(flow: string, outcome: Outcome, target: Target, ctx: unknown): Promise<ChannelResult[]> {
    try {
      const msg = registry[flow]?.userMessage(outcome, ctx)
      if (!msg) return []

      let rcpt: Recipient | null = null
      if (target.userId) {
        try {
          rcpt = await withTimeout(deps.getRecipient(target.userId), LOOKUP_TIMEOUT_MS, "getRecipient")
        } catch (err) {
          console.error("[ADMIN-ACTION] recipient lookup failed:", err instanceof Error ? err.message : err)
        }
      }
      const email = target.email ?? rcpt?.email ?? null
      const phone = target.phone ?? rcpt?.phone ?? null
      const name = target.name ?? rcpt?.name ?? undefined
      const type = `${flow}_${outcome}`
      const reference = target.reference
      const userId = target.userId ?? undefined

      const jobs: Promise<ChannelResult>[] = [
        email
          ? run("user_email", () =>
              deps.sendEmail({ to: [{ email, name }], subject: msg.emailSubject, htmlContent: msg.emailHtml, userId, referenceId: reference, type }),
            )
          : skipped("user_email", "no email"),
        phone
          ? run("user_sms", () => deps.sendSMS({ phone, message: clipSms(msg.sms), type, reference, userId }))
          : skipped("user_sms", "no phone"),
      ]
      if (msg.push) {
        const push = msg.push
        jobs.push(
          userId
            ? run("user_push", () => deps.sendPushToUser(userId, { title: push.title, body: push.body, data: { url: push.url } }))
            : skipped("user_push", "no account"),
        )
      }
      if (msg.inApp) {
        const inApp = msg.inApp
        jobs.push(
          userId
            ? run("user_inapp", async () => {
                const { error } = await deps.insertNotification({
                  user_id: userId,
                  title: inApp.title,
                  message: inApp.message,
                  type: inApp.type,
                  reference_id: reference ?? null,
                  action_url: inApp.actionUrl ?? null,
                  read: false,
                })
                if (error) throw new Error(error.message)
              })
            : skipped("user_inapp", "no account"),
        )
      }
      const results = await Promise.all(jobs)
      logSummary(flow, outcome, reference, results)
      return results
    } catch (err) {
      console.error(`[ADMIN-ACTION] outcome "${flow}/${outcome}" failed:`, err instanceof Error ? err.message : err)
      return []
    }
  }

  return { alertAdminsOfRequest, notifyUserOfOutcome }
}
