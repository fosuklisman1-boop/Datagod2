// lib/hubtel-pay/alert-throttle.ts
// Durable alert throttle shared by the Hubtel payments sweep and lib/payment-gateway/start.ts.
import type { SupabaseClient } from "@supabase/supabase-js"
import { shouldSendAlert } from "@/lib/hubtel-cs/float-alert"

export interface ThrottledAlertOptions {
  /** admin_settings key holding the last-sent stamp. Each key throttles on its own. */
  key: string
  /** notifyAdmins alert type. */
  type: string
  description: string
  windowMs: number
  logPrefix: string
  notify?: (message: string, type: string) => Promise<void>
  now?: () => Date
}

/**
 * One notifyAdmins per windowMs for a key, throttled through an admin_settings stamp (the float-alert.ts pattern),
 * so it holds across Vercel instances. The stamp is written before sending and put back if the send fails. Best effort
 * against truly simultaneous runs, not atomic. A failed read counts as "no recent alert": an unreachable database is
 * exactly when admins should hear about it, and a second alert is better than none. Never throws.
 */
export async function sendThrottledAlert(db: SupabaseClient, message: string, opts: ThrottledAlertOptions): Promise<void> {
  const log = (what: string, e: unknown) => console.error(`${opts.logPrefix} alert ${what}:`, e instanceof Error ? e.message : "unknown error")
  const now = (opts.now ?? (() => new Date()))()
  const write = async (value: unknown) => {
    const { error } = (await db.from("admin_settings").upsert(
      { key: opts.key, value, description: opts.description, updated_at: now.toISOString() },
      { onConflict: "key" },
    )) ?? {}
    if (error) throw new Error(error.message)
  }

  let prev: { timestamp?: string } | null = null
  try {
    const { data, error } = await db.from("admin_settings").select("value").eq("key", opts.key).maybeSingle()
    if (error) log("throttle read failed", new Error(error.message))
    prev = data?.value ?? null
  } catch (e) {
    log("throttle read failed", e)
  }
  if (!shouldSendAlert(prev?.timestamp, now, opts.windowMs)) return

  let stamped = false
  try {
    await write({ timestamp: now.toISOString() })
    stamped = true
  } catch (e) {
    log("throttle stamp failed", e)
  }

  try {
    const notify = opts.notify ?? (async (m: string, t: string) => {
      const { notifyAdmins } = await import("@/lib/sms-service")
      await notifyAdmins(m, t)
    })
    await notify(message, opts.type)
  } catch (e) {
    log("send failed", e)
    if (!stamped) return
    // Nothing went out: put the previous stamp back so the next failure can try again.
    try {
      if (prev) await write(prev)
      else await db.from("admin_settings").delete().eq("key", opts.key)
    } catch (restoreErr) {
      log("throttle restore failed", restoreErr)
    }
  }
}
