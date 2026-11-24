// Admin console: developer pause (write half). The SQL function audits in the same transaction.
import { getControls } from "@/lib/api-v2/controls"
import { bad, callWrite, charLen, NO_ADMIN, REFUSED_SINGLE_LINE, UUID_RE, type RpcClient, type WriteResult } from "./write-common"
import { callRead } from "./read-common"

export type { WriteResult }
interface Deps {
  invalidate: () => void
}
const DEFAULT_DEPS: Deps = { invalidate: () => getControls().invalidate() }

export async function setDeveloperPause(
  client: RpcClient,
  p: { userId: string; paused: boolean; reason: string; actorId: string | undefined },
  deps: Deps = DEFAULT_DEPS
): Promise<WriteResult> {
  if (!p.actorId) return NO_ADMIN
  if (typeof p.userId !== "string" || !UUID_RE.test(p.userId)) return bad("Not a valid developer id.")
  if (typeof p.paused !== "boolean") return bad("paused must be true or false.")
  const reason = typeof p.reason === "string" ? p.reason.trim() : ""
  if (p.paused && (charLen(reason) < 3 || charLen(reason) > 200 || REFUSED_SINGLE_LINE.test(reason))) {
    return bad("Give a reason of 3 to 200 characters, plain text.", "bad_reason")
  }
  const out = await callWrite(client, "api_v2_set_developer_pause", {
    p_user: p.userId,
    p_paused: p.paused,
    p_reason: p.paused ? reason : null,
    p_actor: p.actorId,
  })
  if (!out.ok) return out.result
  if (out.data.changed === true) {
    try {
      deps.invalidate()
    } catch {
      // the 10 s TTL still applies
    }
  }
  return { status: 200, body: { ...out.data, ok: true } }
}

// ---------------- read half: developer list and profile ----------------

export interface DeveloperRow {
  userId: string
  name: string | null
  email: string | null
  role: string | null
  keysActive: number
  keysPending: number
  requests: number
  ok: number
  failed: number
  successRate: number | null
  spent: number
  orders: number
  lastUsedAt: string | null
  granted: boolean
  paused: boolean
}

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null)
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const n = (v: unknown) => {
  const x = Number(v)
  return Number.isFinite(x) ? x : 0
}
const s = (v: unknown): string | null => (typeof v === "string" ? v : null)
const fullName = (o: Obj) => [s(o.first_name), s(o.last_name)].filter(Boolean).join(" ").trim() || null
const rate = (ok: number, total: number) => (total > 0 ? Math.round((ok / total) * 1000) / 10 : null)

/** Last 4 characters only. The SQL already masks; this is the second fence so a raw number can never leave. */
export function maskPhone(v: unknown): string | null {
  if (typeof v !== "string" || !v) return null
  if (v.length <= 4) return "*".repeat(v.length)
  return "*".repeat(v.length - 4) + v.slice(-4)
}

export function shapeDeveloperList(raw: unknown): { total: number; items: DeveloperRow[] } {
  const r = obj(raw)
  if (!r) return { total: 0, items: [] }
  const items: DeveloperRow[] = []
  for (const x of arr(r.items)) {
    const o = obj(x)
    if (!o || typeof o.user_id !== "string") continue
    const requests = n(o.requests)
    const ok = n(o.ok)
    items.push({
      userId: o.user_id,
      name: fullName(o),
      email: s(o.email),
      role: s(o.role),
      keysActive: n(o.keys_active),
      keysPending: n(o.keys_pending),
      requests,
      ok,
      failed: n(o.failed),
      successRate: rate(ok, requests),
      spent: Math.round(n(o.spent) * 100) / 100,
      orders: n(o.orders),
      lastUsedAt: s(o.last_used_at),
      granted: o.granted === true,
      paused: o.paused === true,
    })
  }
  return { total: n(r.total), items }
}

export interface DeveloperProfile {
  user: { id: string; name: string | null; email: string | null; role: string | null; suspended: boolean }
  totals: { requests: number; ok: number; failed: number; successRate: number | null; spent: number; orders: number; pending: number }
  daily: { day: string; requests: number; ok: number; failed: number; revenue: number }[]
  keys: { id: string; keyType: string | null; environment: string | null; status: string | null; name: string | null; keyPrefix: string | null; createdAt: string | null; lastUsedAt: string | null; activity: unknown }[]
  orders: { reference: string | null; network: string | null; volumeGb: number | null; price: number; status: string | null; createdAt: string | null; recipientPhone: string | null }[]
  grant: { grantedAt: string | null; grantedBy: string | null } | null
  pause: { pausedAt: string | null; pausedBy: string | null; reason: string | null } | null
  audit: { action: string | null; adminId: string | null; createdAt: string | null; reason: string | null }[]
}

export function shapeProfile(raw: unknown): DeveloperProfile | null {
  const r = obj(raw)
  const u = r ? obj(r.user) : null
  if (!r || !u || typeof u.id !== "string") return null
  const t = obj(r.totals) ?? {}
  const g = obj(r.grant)
  const p = obj(r.pause)
  return {
    user: { id: u.id, name: fullName(u), email: s(u.email), role: s(u.role), suspended: u.is_suspended === true },
    totals: {
      requests: n(t.requests), ok: n(t.ok), failed: n(t.failed), successRate: rate(n(t.ok), n(t.requests)),
      spent: Math.round(n(t.spent) * 100) / 100, orders: n(t.orders), pending: n(t.pending),
    },
    daily: arr(r.daily).map(obj).filter((d): d is Obj => !!d && typeof d.day === "string")
      .map((d) => ({ day: d.day as string, requests: n(d.requests), ok: n(d.ok), failed: n(d.failed), revenue: n(d.revenue) })),
    // Explicit field list: key_hash (or anything else the SQL might add later) is never copied.
    keys: arr(r.keys).map(obj).filter((k): k is Obj => !!k && typeof k.id === "string")
      .map((k) => ({
        id: k.id as string, keyType: s(k.key_type), environment: s(k.environment), status: s(k.status), name: s(k.name),
        keyPrefix: s(k.key_prefix), createdAt: s(k.created_at), lastUsedAt: s(k.last_used_at), activity: obj(k.activity) ?? null,
      })),
    orders: arr(r.orders).map(obj).filter((o): o is Obj => !!o)
      .map((o) => ({
        reference: s(o.reference), network: s(o.network), volumeGb: o.volume_gb == null ? null : n(o.volume_gb), price: n(o.price),
        status: s(o.status), createdAt: s(o.created_at), recipientPhone: maskPhone(o.recipient_phone),
      })),
    grant: g ? { grantedAt: s(g.granted_at), grantedBy: s(g.granted_by) } : null,
    pause: p ? { pausedAt: s(p.paused_at), pausedBy: s(p.paused_by), reason: s(p.reason) } : null,
    audit: arr(r.audit).map(obj).filter((a): a is Obj => !!a)
      .map((a) => ({ action: s(a.action), adminId: s(a.admin_id), createdAt: s(a.created_at), reason: s(a.reason) })),
  }
}

export const DEVELOPERS_PAGE_SIZE = 25
const SEARCH_MAX = 60
const PROFILE_WINDOW_DAYS = 30

export async function listDevelopers(client: RpcClient, p: { q: string | null; page: number; now: Date }): Promise<WriteResult> {
  const q = (p.q ?? "").trim().slice(0, SEARCH_MAX)
  const page = Number.isInteger(p.page) && p.page > 0 ? Math.min(p.page, 4000) : 0
  const out = await callRead(client, "api_v2_developers", {
    p_since: new Date(p.now.getTime() - PROFILE_WINDOW_DAYS * 86400_000).toISOString(),
    p_search: q || null,
    p_limit: DEVELOPERS_PAGE_SIZE,
    p_offset: page * DEVELOPERS_PAGE_SIZE,
  })
  if (!out.ok) return out.result
  return { status: 200, body: { ...shapeDeveloperList(out.data), page, pageSize: DEVELOPERS_PAGE_SIZE } }
}

export async function getDeveloperProfile(client: RpcClient, userId: string, now: Date): Promise<WriteResult> {
  if (typeof userId !== "string" || !UUID_RE.test(userId)) return bad("Not a valid developer id.")
  const out = await callRead(client, "api_v2_developer_profile", {
    p_user: userId,
    p_since: new Date(now.getTime() - PROFILE_WINDOW_DAYS * 86400_000).toISOString(),
  })
  if (!out.ok) return out.result
  const profile = shapeProfile(out.data)
  if (!profile) return { status: 404, body: { error: "Developer not found.", code: "not_found" } }
  return { status: 200, body: { profile } }
}
