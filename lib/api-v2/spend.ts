/**
 * Release 5 money protection on the request path: a 10 s snapshot of the money switches and thin wrappers around the
 * spend-ledger SQL (migration 0198). Only live keys with caps switched on ever reserve; with caps off nothing here calls
 * the database except the cached settings read.
 *
 * Settings failure rules (same shape as controls.ts): a missing table means the migration is not applied, so caps are
 * off; any other read error keeps the last snapshot; with no snapshot yet the answer is "caps off" — the dark default,
 * never "everyone blocked".
 */
import { getAdminClient, type SupabaseLike } from "./store"
import type { RpcClient } from "./approvals"
import type { V2Context } from "./handler"
import { MSG_DAILY_LIMIT, MSG_DAILY_LIMIT_ADMIN } from "./access"

export type SpendKind = "data" | "data_bulk" | "airtime" | "bill" | "bundle" | "results" | "afa"

export interface MoneySettings {
  capsEnabled: boolean
  alertsEnabled: boolean
  at: number
}

export const MONEY_SETTINGS_TTL_MS = 10_000

function isTableMissing(err: unknown): boolean {
  const e = (err ?? {}) as { code?: string; message?: string }
  if (e.code === "42P01" || e.code === "PGRST205") return true
  const m = (e.message ?? "").toLowerCase()
  return m.includes('relation "api_v2_money_settings" does not exist') || (m.includes("could not find the table") && m.includes("api_v2_money_settings'"))
}

export function createMoneySettings(deps: { client: SupabaseLike; now(): number }): { read(): Promise<MoneySettings>; invalidate(): void } {
  let snap: MoneySettings | null = null
  let inflight: Promise<MoneySettings> | null = null

  async function refresh(now: number): Promise<MoneySettings> {
    try {
      const res = (await deps.client
        .from("api_v2_money_settings")
        .select("caps_enabled, alerts_enabled")
        .eq("id", 1)
        .maybeSingle()) as { data: { caps_enabled?: unknown; alerts_enabled?: unknown } | null; error: unknown }
      if (res.error) {
        if (isTableMissing(res.error)) return (snap = { capsEnabled: false, alertsEnabled: false, at: now })
        return snap ? { ...snap } : { capsEnabled: false, alertsEnabled: false, at: now }
      }
      return (snap = { capsEnabled: res.data?.caps_enabled === true, alertsEnabled: res.data?.alerts_enabled === true, at: now })
    } catch {
      return snap ? { ...snap } : { capsEnabled: false, alertsEnabled: false, at: now }
    }
  }

  return {
    async read() {
      const now = deps.now()
      if (snap && now - snap.at < MONEY_SETTINGS_TTL_MS) return snap
      if (!inflight) {
        inflight = refresh(now).finally(() => {
          inflight = null
        })
      }
      return inflight
    },
    invalidate() {
      snap = null
    },
  }
}

let defaultSettings: ReturnType<typeof createMoneySettings> | null = null
export function getMoneySettings(): ReturnType<typeof createMoneySettings> {
  if (!defaultSettings) defaultSettings = createMoneySettings({ client: getAdminClient(), now: () => Date.now() })
  return defaultSettings
}

export type ReserveResult = { kind: "skipped" } | { kind: "reserved" } | { kind: "cap"; scope: "key" | "user" } | { kind: "error" }

export async function reserveSpend(
  client: RpcClient,
  p: { userId: string; keyId: string; kind: SpendKind; reference: string; amount: number },
): Promise<ReserveResult> {
  try {
    const res = await client.rpc("api_v2_spend_reserve", {
      p_user: p.userId,
      p_key: p.keyId,
      p_kind: p.kind,
      p_reference: p.reference,
      p_amount: p.amount,
    })
    if (res.error) {
      console.error("[api-v2 spend] api_v2_spend_reserve", (res.error as { code?: string }).code ?? "unknown")
      return { kind: "error" }
    }
    const d = (res.data ?? {}) as { ok?: unknown; skipped?: unknown; code?: unknown; scope?: unknown }
    if (d.ok === true) return d.skipped === true ? { kind: "skipped" } : { kind: "reserved" }
    if (d.code === "cap_reached" && (d.scope === "key" || d.scope === "user")) return { kind: "cap", scope: d.scope }
    console.error("[api-v2 spend] api_v2_spend_reserve", typeof d.code === "string" ? d.code : "unexpected")
    return { kind: "error" }
  } catch {
    console.error("[api-v2 spend] api_v2_spend_reserve", "threw")
    return { kind: "error" }
  }
}

/** Never throws. A failed settle leaves the row reserved, which still counts: the safe side. */
export async function settleSpend(
  client: RpcClient,
  p: { keyId: string; kind: SpendKind; reference: string; state: "spent" | "released"; amount?: number },
): Promise<void> {
  try {
    const res = await client.rpc("api_v2_spend_settle", {
      p_key: p.keyId,
      p_kind: p.kind,
      p_reference: p.reference,
      p_state: p.state,
      p_amount: p.amount ?? null,
    })
    if (res.error) console.error("[api-v2 spend] api_v2_spend_settle", (res.error as { code?: string }).code ?? "unknown")
  } catch {
    console.error("[api-v2 spend] api_v2_spend_settle", "threw")
  }
}

export function capMessage(scope: "key" | "user"): string {
  return scope === "user" ? MSG_DAILY_LIMIT_ADMIN : MSG_DAILY_LIMIT
}

/** True only for live keys while caps are switched on. Test keys never reserve. */
export function spendGuard(ctx: V2Context, settings: MoneySettings): boolean {
  return ctx.environment === "live" && settings.capsEnabled
}
