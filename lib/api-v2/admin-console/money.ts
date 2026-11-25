// Release 5 admin money protection: the admin per-person daily limit, the two switches with the risk thresholds,
// and a developer's spend today. Writes take the actor only from verifyAdminAccess (CRON path has none -> 403).
import { getMoneySettings } from "@/lib/api-v2/spend"
import { parseCapInput } from "@/lib/api-v2/spend-caps"
import { bad, callWrite, NO_ADMIN, UUID_RE, type RpcClient, type WriteResult } from "./write-common"
import { callRead, readFailure } from "./read-common"

/** Bounds per threshold (the SQL only requires > 0; these keep an edit from silencing or flooding a signal). */
const RANGES = {
  spike_multiplier: { max: 100, int: false },
  spike_min_ghs: { max: 1_000_000, int: false },
  new_key_hours: { max: 168, int: true },
  new_key_min_ghs: { max: 1_000_000, int: false },
  fanout_recipients: { max: 100_000, int: true },
  fanout_minutes: { max: 1440, int: true },
  cap_hits: { max: 100_000, int: true },
  cap_hits_minutes: { max: 1440, int: true },
  failure_min_orders: { max: 100_000, int: true },
  failure_ratio: { max: 1, int: false },
  failure_minutes: { max: 1440, int: true },
} as const
export type ThresholdKey = keyof typeof RANGES
export const THRESHOLD_KEYS = Object.keys(RANGES) as ThresholdKey[]
export const THRESHOLD_RANGES = RANGES

/** undefined/null = leave thresholds unchanged. Unknown keys are dropped; a known key with a bad value refuses the lot. */
export function parseThresholds(v: unknown): { ok: true; value: Partial<Record<ThresholdKey, number>> | null } | { ok: false } {
  if (v === undefined || v === null) return { ok: true, value: null }
  if (typeof v !== "object" || Array.isArray(v)) return { ok: false }
  const out: Partial<Record<ThresholdKey, number>> = {}
  for (const k of THRESHOLD_KEYS) {
    if (!(k in (v as object))) continue
    const x = (v as Record<string, unknown>)[k]
    const r = RANGES[k]
    if (typeof x !== "number" || !Number.isFinite(x) || x <= 0 || x > r.max || (r.int && !Number.isInteger(x))) return { ok: false }
    out[k] = x
  }
  return { ok: true, value: out }
}

const THRESHOLD_ERROR =
  "Each threshold must be a number greater than 0: minutes up to 1440, new-key hours up to 168, counts whole numbers, the failure ratio at most 1."

export async function setAdminCap(client: RpcClient, p: { userId: string; cap: unknown; actorId: string | undefined }): Promise<WriteResult> {
  if (!p.actorId) return NO_ADMIN
  if (typeof p.userId !== "string" || !UUID_RE.test(p.userId)) return bad("Not a valid developer id.")
  const parsed = parseCapInput(p.cap)
  if (!parsed.ok) return bad("The limit must be an amount in GHS greater than 0 and at most 1,000,000, or empty for no limit.")
  const out = await callWrite(client, "api_v2_set_spend_cap", { p_scope: "user", p_scope_id: p.userId, p_cap: parsed.cap, p_actor: p.actorId })
  if (!out.ok) return out.result
  return { status: 200, body: { ok: true, changed: out.data.changed === true } }
}

interface Deps {
  invalidate: () => void
}
const DEFAULT_DEPS: Deps = { invalidate: () => getMoneySettings().invalidate() }

export async function saveMoneySettings(
  client: RpcClient,
  p: { capsEnabled: unknown; alertsEnabled: unknown; thresholds: unknown; actorId: string | undefined },
  deps: Deps = DEFAULT_DEPS,
): Promise<WriteResult> {
  if (!p.actorId) return NO_ADMIN
  const sw = (v: unknown) => v === null || v === undefined || typeof v === "boolean"
  if (!sw(p.capsEnabled) || !sw(p.alertsEnabled)) return bad("Each switch must be true, false or left out.")
  const t = parseThresholds(p.thresholds)
  if (!t.ok) return bad(THRESHOLD_ERROR)
  const out = await callWrite(client, "api_v2_set_money_settings", {
    p_caps: typeof p.capsEnabled === "boolean" ? p.capsEnabled : null,
    p_alerts: typeof p.alertsEnabled === "boolean" ? p.alertsEnabled : null,
    p_thresholds: t.value,
    p_actor: p.actorId,
  })
  if (!out.ok) return out.result
  const changed = out.data.changed === true
  if (changed) {
    try {
      deps.invalidate()
    } catch {
      // the 10 s TTL still applies
    }
  }
  return { status: 200, body: { ok: true, changed } }
}

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null)
const num = (v: unknown) => (v != null && Number.isFinite(Number(v)) ? Number(v) : 0)
const capOf = (v: unknown) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v))
/** Numbers only: an alert's details never carry a phone or key out, even if the SQL ever stored one. */
const numbersOnly = (v: unknown): Record<string, number> => {
  const o = obj(v) ?? {}
  const out: Record<string, number> = {}
  for (const [k, x] of Object.entries(o)) if (typeof x === "number" && Number.isFinite(x)) out[k] = x
  return out
}
const startOfUtcDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString()

type Chain = PromiseLike<{ data: unknown; error: unknown }> & {
  select(c: string): Chain
  eq(c: string, v: unknown): Chain
  gte(c: string, v: unknown): Chain
  order(c: string, o: { ascending: boolean }): Chain
  limit(n: number): Chain
  maybeSingle(): Promise<{ data: unknown; error: unknown }>
}
const table = (client: RpcClient, name: string) => (client as unknown as { from(t: string): Chain }).from(name)

export async function getMoneySettingsAdmin(client: RpcClient, now: Date): Promise<WriteResult> {
  try {
    const s = await table(client, "api_v2_money_settings").select("caps_enabled, alerts_enabled, thresholds, updated_at").eq("id", 1).maybeSingle()
    if (s.error) return readFailure("api_v2_money_settings", s.error)
    const a = await table(client, "api_v2_risk_alerts").select("id").gte("created_at", startOfUtcDay(now)).limit(1000)
    if (a.error) return readFailure("api_v2_risk_alerts", a.error)
    const row = obj(s.data) ?? {}
    const raw = numbersOnly(row.thresholds)
    const thresholds: Partial<Record<ThresholdKey, number>> = {}
    for (const k of THRESHOLD_KEYS) if (k in raw) thresholds[k] = raw[k]
    return {
      status: 200,
      body: {
        capsEnabled: row.caps_enabled === true,
        alertsEnabled: row.alerts_enabled === true,
        thresholds,
        updatedAt: typeof row.updated_at === "string" ? row.updated_at : null,
        alertsToday: Array.isArray(a.data) ? a.data.length : 0,
      },
    }
  } catch {
    return readFailure("money settings", null)
  }
}

export async function getDeveloperSpend(client: RpcClient, userId: string): Promise<WriteResult> {
  if (typeof userId !== "string" || !UUID_RE.test(userId)) return bad("Not a valid developer id.")
  const t = await callRead(client, "api_v2_spend_today", { p_user: userId })
  if (!t.ok) return t.result
  let alertsRaw: unknown[] = []
  try {
    const a = await table(client, "api_v2_risk_alerts").select("signal, created_at, details").eq("user_id", userId).order("created_at", { ascending: false }).limit(10)
    if (a.error) return readFailure("api_v2_risk_alerts", a.error)
    alertsRaw = Array.isArray(a.data) ? a.data : []
  } catch {
    return readFailure("api_v2_risk_alerts", null)
  }
  const d = obj(t.data) ?? {}
  const u = obj(d.user) ?? {}
  return {
    status: 200,
    body: {
      today: num(u.spent),
      userCap: capOf(u.cap),
      keys: (Array.isArray(d.keys) ? d.keys : []).map(obj).filter((k): k is Obj => !!k && typeof k.key_id === "string")
        .map((k) => ({ keyId: k.key_id as string, spent: num(k.spent), cap: capOf(k.cap) })),
      refusalsToday: num(d.refusals_today),
      alerts: alertsRaw.map(obj).filter((x): x is Obj => !!x && typeof x.signal === "string")
        .map((x) => ({ signal: x.signal as string, createdAt: typeof x.created_at === "string" ? x.created_at : null, details: numbersOnly(x.details) })),
    },
  }
}
