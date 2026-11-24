/**
 * Release 5: the developer's own daily spending limit per live key (dashboard session only; never an API key).
 * The admin per-person limit is never returned here: only whether one applies.
 */
import type { RpcClient } from "./approvals"
import type { WriteResult } from "./admin-console/write-common"

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const CAP_MAX = 1000000

/** null or "" = no limit. Otherwise a positive number <= 1000000 with at most two decimals. */
export function parseCapInput(v: unknown): { ok: true; cap: number | null } | { ok: false } {
  if (v === null || v === "") return { ok: true, cap: null }
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d+(\.\d{1,2})?$/.test(v.trim()) ? Number(v.trim()) : NaN
  if (!Number.isFinite(n) || n <= 0 || n > CAP_MAX || Math.round(n * 100) !== n * 100) return { ok: false }
  return { ok: true, cap: n }
}

const bad = (error: string): WriteResult => ({ status: 400, body: { error, code: "bad_input" } })
const notFound: WriteResult = { status: 404, body: { error: "Key not found.", code: "not_found" } }

export async function setDeveloperCap(client: RpcClient, p: { userId: string; keyId: string; cap: unknown }): Promise<WriteResult> {
  if (typeof p.keyId !== "string" || !UUID_RE.test(p.keyId)) return bad("Not a valid key id.")
  const parsed = parseCapInput(p.cap)
  if (!parsed.ok) return bad("The limit must be an amount in GHS greater than 0 and at most 1,000,000, or empty for no limit.")
  let res: { data: unknown; error: unknown }
  try {
    res = await client.rpc("api_v2_set_spend_cap", { p_scope: "key", p_scope_id: p.keyId, p_cap: parsed.cap, p_actor: p.userId })
  } catch {
    console.error("[api-v2 spend-cap] api_v2_set_spend_cap", "threw")
    return { status: 500, body: { error: "Could not save the limit. Please try again.", code: "error" } }
  }
  if (res.error) {
    console.error("[api-v2 spend-cap] api_v2_set_spend_cap", (res.error as { code?: string }).code ?? "unknown")
    return { status: 500, body: { error: "Could not save the limit. Please try again.", code: "error" } }
  }
  const d = (res.data ?? {}) as { ok?: unknown; changed?: unknown; code?: unknown }
  if (d.ok === true) return { status: 200, body: { ok: true, changed: d.changed === true } }
  if (d.code === "not_found") return notFound
  if (d.code === "not_live") return bad("Daily limits apply to live keys only.")
  return bad("The limit could not be saved.")
}

export async function getKeySpend(client: RpcClient, p: { userId: string; keyId: string; capsActive: boolean }): Promise<WriteResult> {
  if (typeof p.keyId !== "string" || !UUID_RE.test(p.keyId)) return bad("Not a valid key id.")
  type KeyRow = { user_id?: unknown; environment?: unknown }
  const key: KeyRow | null = await (async () => {
    try {
      const r = (await client.from("api_v2_keys").select("user_id, environment").eq("id", p.keyId).maybeSingle()) as { data: KeyRow | null }
      return r.data
    } catch {
      return null
    }
  })()
  if (!key || key.user_id !== p.userId) return notFound
  if (key.environment !== "live") return bad("Daily limits apply to live keys only.")
  let res: { data: unknown; error: unknown }
  try {
    res = await client.rpc("api_v2_spend_today", { p_user: p.userId })
  } catch {
    return { status: 500, body: { error: "Could not load today's spend.", code: "error" } }
  }
  if (res.error) return { status: 500, body: { error: "Could not load today's spend.", code: "error" } }
  const t = (res.data ?? {}) as { user?: { cap?: unknown }; keys?: { key_id?: unknown; spent?: unknown; cap?: unknown }[] }
  const k = (Array.isArray(t.keys) ? t.keys : []).find((x) => x.key_id === p.keyId)
  const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0)
  return {
    status: 200,
    body: {
      spentToday: num(k?.spent),
      cap: k?.cap == null ? null : num(k.cap),
      adminLimitApplies: t.user?.cap != null,
      active: p.capsActive,
    },
  }
}
