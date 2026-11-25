/**
 * Release 5 money protection, SERVER side: a 10 s snapshot of the money switches, thin wrappers around the spend-ledger
 * SQL (migration 0198) and the default hook the production deps wire in. The pure request-path guard lives in
 * ./spend-guard.ts (browser-safe) and is re-exported here.
 *
 * Settings failure rules (same shape as controls.ts): a missing table means the migration is not applied, so caps are
 * off; any other read error keeps the last snapshot; with no snapshot yet the answer is "caps off" — the dark default,
 * never "everyone blocked".
 */
import { createHash } from "node:crypto"
import { getAdminClient, type SupabaseLike } from "./store"
import type { RpcClient } from "./approvals"
import type { MoneySettings, ReserveResult, SpendHook, SpendKind } from "./spend-guard"

export * from "./spend-guard"

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

/**
 * A data_bulk reference ALWAYS reaches the ledger as bulkh:<sha256 of the raw "bulk:..." form>: stable, <= 200
 * characters, and never a pass-through (review C1: a client-chosen reference that merely looked hashed could otherwise
 * land on another batch's row). Other kinds pass through unchanged.
 */
export function ledgerReference(kind: SpendKind, reference: string): string {
  if (kind !== "data_bulk") return reference
  return "bulkh:" + createHash("sha256").update(reference, "utf8").digest("hex")
}

export async function reserveSpend(
  client: RpcClient,
  p: { userId: string; keyId: string; kind: SpendKind; reference: string; amount: number },
): Promise<ReserveResult> {
  try {
    const res = await client.rpc("api_v2_spend_reserve", {
      p_user: p.userId,
      p_key: p.keyId,
      p_kind: p.kind,
      p_reference: ledgerReference(p.kind, p.reference),
      p_amount: p.amount,
    })
    if (res.error) {
      console.error("[api-v2 spend] api_v2_spend_reserve", (res.error as { code?: string }).code ?? "unknown")
      return { kind: "error" }
    }
    const d = (res.data ?? {}) as { ok?: unknown; skipped?: unknown; existing?: unknown; state?: unknown; age_s?: unknown; code?: unknown; scope?: unknown }
    if (d.ok === true) {
      if (d.skipped === true) return { kind: "skipped" }
      // an unknown state is treated as still reserved (the cautious reading); a missing age reads as in flight
      if (d.existing === true) {
        const state = d.state === "spent" ? "spent" : "reserved"
        return typeof d.age_s === "number" && Number.isFinite(d.age_s) && d.age_s >= 0 ? { kind: "existing", state, ageSeconds: d.age_s } : { kind: "existing", state }
      }
      return { kind: "reserved" }
    }
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
      p_reference: ledgerReference(p.kind, p.reference),
      p_state: p.state,
      p_amount: p.amount ?? null,
    })
    if (res.error) console.error("[api-v2 spend] api_v2_spend_settle", (res.error as { code?: string }).code ?? "unknown")
  } catch {
    console.error("[api-v2 spend] api_v2_spend_settle", "threw")
  }
}

export function defaultSpendHook(): SpendHook {
  return {
    settings: () => getMoneySettings().read(),
    reserve: (p) => reserveSpend(getAdminClient() as unknown as RpcClient, p),
    settle: (p) => settleSpend(getAdminClient() as unknown as RpcClient, p),
  }
}
