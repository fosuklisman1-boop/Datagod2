/**
 * Release 3 low-balance alert sweep (cron /api/cron/api-v2-balance-alerts). The 0199 scan disarms each row it returns
 * under a row lock, so a person is told once per crossing. Free channels only: in-app, push and email (never SMS).
 * Each channel is independent: one failing never stops the others. Logs carry counts only, never contacts.
 */
import type { RpcLike } from "./dev-dashboard"

export interface Fired {
  user_id: string
  threshold: number
  balance: number
}

export interface AlertDeps {
  contact(userId: string): Promise<{ email: string | null; name: string | null } | null>
  inApp(userId: string, title: string, message: string): Promise<void>
  push(userId: string, title: string, message: string): Promise<void>
  email(to: { email: string; name: string | null }, subject: string, text: string, html: string): Promise<void>
}

const ghs = (n: number) => `GHS ${(Math.round(Number(n) * 100) / 100).toFixed(2)}`

export function alertText(f: Fired): { title: string; message: string } {
  return {
    title: "Low wallet balance",
    message: `Your Datagod wallet balance is ${ghs(f.balance)}, below your alert level of ${ghs(f.threshold)}. Top up so your API orders keep going through.`,
  }
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string)

export async function runBalanceAlertSweep(client: RpcLike, now: Date, deps: AlertDeps): Promise<{ fired: number; failed: number }> {
  const { data, error } = await client.rpc("api_v2_balance_alert_scan", { p_now: now.toISOString() })
  if (error) throw new Error("balance alert scan failed")
  const fired = (Array.isArray(data) ? data : []) as Fired[]
  let failed = 0
  for (const f of fired) {
    const { title, message } = alertText(f)
    const results = await Promise.allSettled([
      deps.inApp(f.user_id, title, message),
      deps.push(f.user_id, title, message),
      (async () => {
        const c = await deps.contact(f.user_id)
        if (!c?.email) return
        const html = `<p>${escapeHtml(c.name ? `Hello ${c.name},` : "Hello,")}</p><p>${escapeHtml(message)}</p><p>You can change or remove this alert on your Developer API dashboard.</p>`
        await deps.email({ email: c.email, name: c.name }, title, `${message}\n\nYou can change or remove this alert on your Developer API dashboard.`, html)
      })(),
    ])
    if (results.some((r) => r.status === "rejected")) failed++
  }
  if (fired.length) console.log(`[api-v2-balance-alerts] notified ${fired.length}, with a channel failure ${failed}`)
  return { fired: fired.length, failed }
}
