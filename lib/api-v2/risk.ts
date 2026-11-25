/**
 * Release 5 fraud warnings: one sweep (every 5 minutes) calls api_v2_risk_scan (migration 0198, [] while alerts are
 * off), records each candidate in api_v2_risk_alerts (UNIQUE user, signal, bucket) and notifies admins only for rows
 * that were actually inserted, so one pattern alerts once per window. Messages carry the developer's name, the signal
 * in plain words, the numbers and the profile link; never phone numbers or keys. Nothing is blocked automatically.
 */
import type { RpcClient } from "./approvals"

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const RISK_LABELS: Record<string, string> = {
  spend_spike: "spending far above their usual day",
  new_key_big_spend: "a brand-new key spending heavily",
  recipient_fanout: "many different numbers in a few minutes",
  cap_hits: "repeatedly hitting their daily limit",
  failure_burst: "a burst of failed purchases",
}

interface Candidate {
  user_id: string
  signal: string
  bucket: string
  details: Record<string, unknown>
}

function numbers(details: Record<string, unknown>): string {
  return Object.entries(details)
    .filter(([, v]) => typeof v === "number" && Number.isFinite(v))
    .map(([k, v]) => `${k.replace(/_/g, " ")} ${v}`)
    .join(", ")
}

export function riskMessage(p: { name: string; userId: string; signal: string; details: Record<string, unknown> }): string {
  const label = RISK_LABELS[p.signal] ?? p.signal
  const nums = numbers(p.details)
  return `Datagod API alert: ${p.name} is ${label}${nums ? ` (${nums})` : ""}. Review and pause if needed: /admin/api-keys?tab=developers&dev=${p.userId}`
}

function valid(c: unknown): c is Candidate {
  if (!c || typeof c !== "object") return false
  const o = c as Record<string, unknown>
  return typeof o.user_id === "string" && UUID_RE.test(o.user_id) && typeof o.signal === "string" && o.signal in RISK_LABELS && typeof o.bucket === "string"
}

export async function runRiskSweep(client: RpcClient, now: Date, notify: (message: string) => Promise<void>): Promise<{ found: number; sent: number }> {
  let scan: unknown
  try {
    const res = await client.rpc("api_v2_risk_scan", { p_now: now.toISOString() })
    if (res.error) {
      console.error("[api-v2 risk] api_v2_risk_scan", (res.error as { code?: string }).code ?? "unknown")
      return { found: 0, sent: 0 }
    }
    scan = res.data
  } catch {
    console.error("[api-v2 risk] api_v2_risk_scan", "threw")
    return { found: 0, sent: 0 }
  }
  const candidates = (Array.isArray(scan) ? scan : []).filter(valid)
  if (candidates.length === 0) return { found: 0, sent: 0 }

  let inserted: Candidate[] = []
  try {
    const rows = candidates.map((c) => ({ user_id: c.user_id, signal: c.signal, bucket: c.bucket, details: c.details && typeof c.details === "object" ? c.details : {} }))
    const res = (await client
      .from("api_v2_risk_alerts")
      .upsert(rows, { onConflict: "user_id,signal,bucket", ignoreDuplicates: true })
      .select("user_id, signal, bucket, details")) as { data: Candidate[] | null; error: unknown }
    if (res.error) {
      console.error("[api-v2 risk] insert", (res.error as { code?: string }).code ?? "unknown")
      return { found: candidates.length, sent: 0 }
    }
    inserted = (res.data ?? []).filter(valid)
  } catch {
    console.error("[api-v2 risk] insert", "threw")
    return { found: candidates.length, sent: 0 }
  }
  if (inserted.length === 0) return { found: candidates.length, sent: 0 }

  const names = new Map<string, string>()
  try {
    const ids = [...new Set(inserted.map((i) => i.user_id))]
    const res = (await client.from("users").select("id, first_name, last_name").in("id", ids)) as {
      data: { id: string; first_name: string | null; last_name: string | null }[] | null
    }
    for (const u of res.data ?? []) names.set(u.id, [u.first_name, u.last_name].filter(Boolean).join(" ").trim())
  } catch {
    // names are cosmetic; the link identifies the person
  }

  let sent = 0
  for (const i of inserted) {
    try {
      await notify(riskMessage({ name: names.get(i.user_id) || "A developer", userId: i.user_id, signal: i.signal, details: i.details ?? {} }))
      sent++
    } catch {
      // alerting must never break the sweep; the alert row is already recorded
    }
  }
  return { found: candidates.length, sent }
}
