// Admin side of API approvals: decisions through the atomic api_v2_* SQL functions (migration 0195), the
// approvals inbox, grants and history. Routes stay thin; every function here is testable with a fake client.
import { notifyUserOfOutcome } from "@/lib/admin-actions"
import { parseSignalsResult, signalsRpcArgs, type RawUserSignals } from "@/lib/admin-users/risk-signals"
import type { KeyType } from "./keys"
import { getConfig, type SupabaseLike } from "./store"

type RpcResult = { data: unknown; error: { code?: string; message?: string } | null }
export type RpcClient = SupabaseLike & { rpc(fn: string, args: Record<string, unknown>): PromiseLike<RpcResult> }

export type DecisionCode = "not_found" | "stale" | "suspended" | "not_eligible" | "bad_reason" | "busy" | "error"

export const DECISION_STATUS: Record<DecisionCode, number> = {
  not_found: 404,
  stale: 409,
  suspended: 409,
  not_eligible: 409,
  bad_reason: 400,
  busy: 503,
  error: 500,
}

const DECISION_MESSAGE: Record<DecisionCode, string> = {
  not_found: "This request no longer exists.",
  stale: "This request was already decided or changed. Refresh and try again.",
  suspended: "This account is suspended, so it cannot be approved.",
  not_eligible: "This account is not eligible for the API any more (role or grant changed).",
  bad_reason: "Give a reason of 3 to 200 characters.",
  busy: "Busy, try again in a moment.",
  error: "Something went wrong. Please try again.",
}

const KNOWN: ReadonlySet<string> = new Set(["not_found", "stale", "suspended", "not_eligible", "bad_reason"])

/** Maps an api_v2_* function result. A lock timeout or deadlock is retryable ("busy"); anything unknown is "error". */
export function rpcOutcome(res: RpcResult): { ok: true; data: Record<string, unknown> } | { ok: false; code: DecisionCode } {
  if (res.error) return { ok: false, code: res.error.code === "55P03" || res.error.code === "40P01" ? "busy" : "error" }
  const d = res.data as Record<string, unknown> | null
  if (d && d.ok === true) return { ok: true, data: d }
  if (d && typeof d.code === "string" && KNOWN.has(d.code)) return { ok: false, code: d.code as DecisionCode }
  return { ok: false, code: "error" }
}

type Notify = typeof notifyUserOfOutcome
interface Deps {
  notify: Notify
}
const DEFAULT_DEPS: Deps = { notify: notifyUserOfOutcome }

export interface RouteResult {
  status: number
  body: Record<string, unknown>
}

const fail = (code: DecisionCode): RouteResult => ({ status: DECISION_STATUS[code], body: { error: DECISION_MESSAGE[code], code } })
const NO_ADMIN: RouteResult = { status: 403, body: { error: "Sign in with an admin account to decide requests." } }

/** Best-effort read of the request code and key type for the developer's message. */
async function requestInfo(client: SupabaseLike, kind: "key" | "access", id: string): Promise<{ code?: string; keyType?: KeyType }> {
  try {
    const table = kind === "key" ? "api_v2_keys" : "api_v2_access_requests"
    const cols = kind === "key" ? "request_code, key_type" : "request_code"
    const { data } = await client.from(table).select(cols).eq("id", id).maybeSingle()
    return { code: data?.request_code ?? undefined, keyType: data?.key_type ?? undefined }
  } catch {
    return {}
  }
}

/**
 * Approves or rejects a live-key request (kind "key", which covers swaps) or an access request. The SQL function
 * decides atomically and writes the audit row; the developer is told only after it succeeded.
 */
export async function decide(
  client: RpcClient,
  p: { kind: "key" | "access"; action: "approve" | "reject"; id: string; actorId: string | undefined; reason?: string },
  deps: Deps = DEFAULT_DEPS
): Promise<RouteResult> {
  if (!p.actorId) return NO_ADMIN
  const info = await requestInfo(client, p.kind, p.id)
  const reason = typeof p.reason === "string" ? p.reason : ""
  const call =
    p.kind === "key"
      ? p.action === "approve"
        ? client.rpc("api_v2_approve_key", { p_key: p.id, p_actor: p.actorId })
        : client.rpc("api_v2_reject_key", { p_key: p.id, p_actor: p.actorId, p_reason: reason })
      : p.action === "approve"
        ? client.rpc("api_v2_approve_access", { p_request: p.id, p_actor: p.actorId })
        : client.rpc("api_v2_reject_access", { p_request: p.id, p_actor: p.actorId, p_reason: reason })
  let res: RpcResult
  try {
    res = await call
  } catch {
    return fail("error")
  }
  const out = rpcOutcome(res)
  if (!out.ok) return fail(out.code)

  const userId = typeof out.data.user_id === "string" ? out.data.user_id : null
  const keyType = (typeof out.data.key_type === "string" ? out.data.key_type : info.keyType) as KeyType | undefined
  const kind = p.kind === "access" ? "access" : out.data.replaced_key_id ? "swap" : "key"
  if (userId) {
    try {
      await deps.notify(
        "api_access",
        p.action === "approve" ? "approved" : "rejected",
        { userId, reference: info.code },
        { kind, code: info.code, keyType, reason: p.action === "reject" ? reason.trim() : undefined }
      )
    } catch {
      // the decision stands even when the message fails
    }
  }
  return { status: 200, body: { ...out.data, ok: true } }
}

/** Removes a per-person grant. Keys are not revoked; they stop on the next request if the role is not allowed. */
export async function removeGrant(
  client: RpcClient,
  p: { userId: string; actorId: string | undefined; reason: string },
  deps: Deps = DEFAULT_DEPS
): Promise<RouteResult> {
  if (!p.actorId) return NO_ADMIN
  let res: RpcResult
  try {
    res = await client.rpc("api_v2_remove_grant", { p_user: p.userId, p_actor: p.actorId, p_reason: p.reason })
  } catch {
    return fail("error")
  }
  const out = rpcOutcome(res)
  if (!out.ok) return fail(out.code)
  try {
    await deps.notify("api_access", "removed", { userId: p.userId }, { kind: "access", reason: p.reason.trim() })
  } catch {
    // the removal stands even when the message fails
  }
  return { status: 200, body: { ok: true } }
}

export interface ApprovalItem {
  id: string
  kind: "key" | "swap" | "access"
  code: string
  keyType: KeyType | null
  createdAt: string
  owner: {
    id: string
    name: string
    email: string | null
    phone: string | null
    role: string
    accountCreatedAt: string | null
    phoneVerified: boolean | null
    samePhoneAccounts: number | null
    suspended: boolean
    eligible: boolean
  }
  context: { balance: number; topups30d: number; orders30d: number } | null
}

export const PAGE_SIZE = 25
const CHUNK = 200
const MAX_PENDING = 2000

/** Plain-text search over code, name, email and phone. Nothing in `q` is ever sent to the database. */
export function matchesQuery(item: Pick<ApprovalItem, "code" | "owner">, q: string): boolean {
  const s = q.trim().toLowerCase()
  if (!s) return true
  if (item.code.toLowerCase().includes(s)) return true
  if (item.owner.name.toLowerCase().includes(s)) return true
  if (item.owner.email?.toLowerCase().includes(s)) return true
  const digits = s.replace(/\D/g, "")
  if (digits.length >= 3 && item.owner.phone && item.owner.phone.replace(/\D/g, "").includes(digits)) return true
  return false
}

function chunks<T>(xs: T[]): T[][] {
  const out: T[][] = []
  for (let i = 0; i < xs.length; i += CHUNK) out.push(xs.slice(i, i + CHUNK))
  return out
}

async function readAll(build: (ids: string[]) => PromiseLike<{ data: unknown; error: unknown }>, ids: string[]): Promise<any[] | null> {
  const rows: any[] = []
  for (const part of chunks(ids)) {
    const { data, error } = await build(part)
    if (error || !Array.isArray(data)) return null
    rows.push(...data)
  }
  return rows
}

/**
 * The approvals inbox: pending live keys (a "swap" when the slot already has an active key) and pending access
 * requests, oldest first, filtered by `q` in memory, then paginated. Keys, requests, owners and grants must all
 * read or the whole call is "error" (never a partial inbox). Risk signals and the 30-day context are extras:
 * when they fail the items still list, without them.
 */
export async function listApprovals(client: RpcClient, p: { q: string; page: number }): Promise<{ items: ApprovalItem[]; total: number } | "error"> {
  try {
    const [keys, requests] = await Promise.all([
      client.from("api_v2_keys").select("id, user_id, key_type, request_code, created_at").eq("status", "pending").eq("environment", "live").order("created_at", { ascending: true }).range(0, MAX_PENDING - 1),
      client.from("api_v2_access_requests").select("id, user_id, request_code, created_at").eq("status", "pending").order("created_at", { ascending: true }).range(0, MAX_PENDING - 1),
    ])
    if (keys.error || requests.error || !Array.isArray(keys.data) || !Array.isArray(requests.data)) return "error"
    const userIds = Array.from(new Set([...keys.data, ...requests.data].map((r: any) => r.user_id as string)))
    if (userIds.length === 0) return { items: [], total: 0 }

    const [users, active, grants, config] = await Promise.all([
      readAll((ids) => client.from("users").select("id, first_name, last_name, email, phone_number, role, is_suspended").in("id", ids), userIds),
      readAll((ids) => client.from("api_v2_keys").select("user_id, key_type").eq("status", "active").eq("environment", "live").in("user_id", ids), userIds),
      readAll((ids) => client.from("api_v2_access_grants").select("user_id").in("user_id", ids), userIds),
      getConfig(client),
    ])
    if (!users || !active || !grants) return "error"

    const userById = new Map(users.map((u) => [u.id as string, u]))
    const granted = new Set(grants.map((g) => g.user_id as string))
    const hasActive = new Set(active.map((a) => `${a.user_id}:${a.key_type}`))

    const owner = (id: string): ApprovalItem["owner"] => {
      const u = userById.get(id) ?? {}
      const name = [u.first_name, u.last_name].filter((s: unknown) => typeof s === "string" && s.trim()).join(" ").trim()
      const role = typeof u.role === "string" ? u.role : ""
      return {
        id,
        name: name || "(no name)",
        email: typeof u.email === "string" ? u.email : null,
        phone: typeof u.phone_number === "string" ? u.phone_number : null,
        role,
        accountCreatedAt: null,
        phoneVerified: null,
        samePhoneAccounts: null,
        suspended: Boolean(u.is_suspended),
        eligible: granted.has(id) || config.allowed_roles.includes(role),
      }
    }

    const all: ApprovalItem[] = [
      ...keys.data.map((k: any) => ({
        id: k.id,
        kind: hasActive.has(`${k.user_id}:${k.key_type}`) ? ("swap" as const) : ("key" as const),
        code: k.request_code ?? "",
        keyType: k.key_type as KeyType,
        createdAt: k.created_at,
        owner: owner(k.user_id),
        context: null,
      })),
      ...requests.data.map((r: any) => ({
        id: r.id,
        kind: "access" as const,
        code: r.request_code ?? "",
        keyType: null,
        createdAt: r.created_at,
        owner: owner(r.user_id),
        context: null,
      })),
    ]
      .filter((i) => matchesQuery(i, p.q))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))

    const page = Math.max(0, Math.floor(p.page) || 0)
    const items = all.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE)
    await attachExtras(client, items)
    return { items, total: all.length }
  } catch {
    return "error"
  }
}

/** Adds risk signals and the 30-day context to one page of items. Failures leave the fields empty. */
async function attachExtras(client: RpcClient, items: ApprovalItem[]): Promise<void> {
  const ids = Array.from(new Set(items.map((i) => i.owner.id)))
  if (ids.length === 0) return
  let signals = new Map<string, RawUserSignals>()
  try {
    const res = await client.rpc("admin_user_signals", signalsRpcArgs(ids))
    if (!res.error) signals = parseSignalsResult(res.data)
  } catch {
    // signals stay empty
  }
  type ContextRow = { topups_30d?: unknown; orders_30d?: unknown }
  let context: Record<string, ContextRow> | null = null
  try {
    const res = await client.rpc("api_v2_approval_context", { p_users: ids })
    if (!res.error && res.data && typeof res.data === "object" && !Array.isArray(res.data)) context = res.data as Record<string, ContextRow>
  } catch {
    // context stays null
  }
  const num = (v: unknown) => (typeof v === "number" ? v : Number(v ?? 0)) || 0
  for (const i of items) {
    const s = signals.get(i.owner.id)
    if (s) {
      i.owner.accountCreatedAt = s.created_at
      i.owner.phoneVerified = s.phone_verified
      i.owner.samePhoneAccounts = s.same_phone_accounts
    }
    const c = context?.[i.owner.id]
    i.context = c ? { balance: s ? s.wallet_balance : 0, topups30d: num(c.topups_30d), orders30d: num(c.orders_30d) } : null
  }
}

const pageRange = (page: number) => {
  const p = Math.max(0, Math.floor(page) || 0)
  return [p * PAGE_SIZE, p * PAGE_SIZE + PAGE_SIZE - 1] as const
}

/** API approval history from admin_audit_log (actions api_*), newest first. */
export async function listHistory(client: SupabaseLike, page: number): Promise<{ items: unknown[]; total: number } | "error"> {
  try {
    const [from, to] = pageRange(page)
    const { data, error, count } = await client
      .from("admin_audit_log")
      .select("id, admin_id, action, target_user_id, old_value, new_value, created_at", { count: "exact" })
      .like("action", "api\\_%")
      .order("created_at", { ascending: false })
      .range(from, to)
    if (error || !Array.isArray(data)) return "error"
    return { items: data, total: typeof count === "number" ? count : data.length }
  } catch {
    return "error"
  }
}

/** Current per-person grants with their owners, newest first. */
export async function listGrants(client: SupabaseLike, page: number): Promise<{ items: unknown[]; total: number } | "error"> {
  try {
    const [from, to] = pageRange(page)
    const { data, error, count } = await client
      .from("api_v2_access_grants")
      .select("user_id, granted_by, granted_at", { count: "exact" })
      .order("granted_at", { ascending: false })
      .range(from, to)
    if (error || !Array.isArray(data)) return "error"
    const ids = data.map((g: any) => g.user_id as string)
    const users = ids.length ? await readAll((part) => client.from("users").select("id, first_name, last_name, email, role").in("id", part), ids) : []
    if (!users) return "error"
    const byId = new Map(users.map((u) => [u.id as string, u]))
    return {
      items: data.map((g: any) => {
        const u = byId.get(g.user_id) ?? {}
        const name = [u.first_name, u.last_name].filter((s: unknown) => typeof s === "string" && s.trim()).join(" ").trim()
        return { userId: g.user_id, name: name || "(no name)", email: u.email ?? null, role: u.role ?? "", grantedAt: g.granted_at, grantedBy: g.granted_by }
      }),
      total: typeof count === "number" ? count : data.length,
    }
  } catch {
    return "error"
  }
}
