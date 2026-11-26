// Release 6 developer webhook tools, behind the session routes /api/user/v2-dashboard/webhook*. userId always comes from
// the verified session. The full secret leaves the server only: once when it is created or rotated, and on Reveal.
import { checkUrlSyntax, resolveSafe } from "./url-guard"
import { deliverOne, type CycleDeps, type Job, type RpcClientLike } from "./worker"

export interface DevDeps extends CycleDeps {
  newSecret(): string
}
type Out = { status: number; body: unknown }

const UNAVAILABLE: Out = { status: 503, body: { error: "Webhooks are unavailable right now. Try again shortly.", code: "unavailable" } }
const bad = (error: string): Out => ({ status: 400, body: { error, code: "bad_input" } })
const EVENT_RE = /^evt_[0-9a-f]{24}$/
const CURSOR_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2}))\|(evt_[0-9a-f]{24})$/
const PAGE = 25

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null)

async function rpc(client: RpcClientLike, fn: string, args: Obj): Promise<{ ok: true; data: unknown } | { ok: false }> {
  try {
    const r = await client.rpc(fn, args)
    return r.error ? { ok: false } : { ok: true, data: r.data }
  } catch {
    return { ok: false }
  }
}

export async function getWebhook(client: RpcClientLike, userId: string): Promise<Out> {
  const r = await rpc(client, "api_v2_webhook_get", { p_user: userId })
  return r.ok && obj(r.data) ? { status: 200, body: r.data } : UNAVAILABLE
}

/** Body { url, enabled? }. The URL is checked (syntax + every DNS answer public) before anything is stored. */
export async function saveWebhook(client: RpcClientLike, userId: string, raw: unknown, deps: DevDeps): Promise<Out> {
  const b = obj(raw)
  if (!b || typeof b.url !== "string") return bad("Send { url } with your HTTPS webhook URL.")
  if (b.enabled !== undefined && typeof b.enabled !== "boolean") return bad("enabled must be true or false.")
  const syntax = checkUrlSyntax(b.url)
  if (!syntax.ok) return bad(syntax.error)
  // Only re-check DNS for a new or changed URL: switching the stored URL on or off must work even if its host has since
  // stopped resolving (every send still re-checks DNS, so nothing reaches a private address either way).
  const current = typeof b.enabled === "boolean" ? await rpc(client, "api_v2_webhook_get", { p_user: userId }) : null
  const stored = current?.ok ? obj(obj(current.data)?.endpoint) : null
  if (stored?.url !== syntax.url) {
    const addr = await resolveSafe(syntax.host, deps.resolve)
    if (!addr.ok) return bad(addr.error)
  }
  const secret = deps.newSecret()
  const r = await rpc(client, "api_v2_webhook_set_endpoint", {
    p_user: userId,
    p_url: syntax.url,
    p_enabled: typeof b.enabled === "boolean" ? b.enabled : null,
    p_new_secret: secret,
  })
  const d = r.ok ? obj(r.data) : null
  if (!d) return UNAVAILABLE
  return { status: 200, body: d.created === true ? { ...d, secret } : d }
}

export async function deleteWebhook(client: RpcClientLike, userId: string): Promise<Out> {
  const r = await rpc(client, "api_v2_webhook_delete_endpoint", { p_user: userId })
  return r.ok && obj(r.data) ? { status: 200, body: r.data } : UNAVAILABLE
}

export async function revealSecret(client: RpcClientLike, userId: string): Promise<Out> {
  const r = await rpc(client, "api_v2_webhook_reveal", { p_user: userId })
  if (!r.ok) return UNAVAILABLE
  return typeof r.data === "string" ? { status: 200, body: { secret: r.data } } : { status: 404, body: { error: "Save a webhook URL first.", code: "no_endpoint" } }
}

export async function rotateSecret(client: RpcClientLike, userId: string, deps: DevDeps): Promise<Out> {
  const secret = deps.newSecret()
  const r = await rpc(client, "api_v2_webhook_rotate_secret", { p_user: userId, p_new_secret: secret })
  const d = r.ok ? obj(r.data) : null
  if (!d) return UNAVAILABLE
  if (d.error === "no_endpoint") return { status: 404, body: { error: "Save a webhook URL first.", code: "no_endpoint" } }
  return { status: 200, body: { ...d, secret } }
}

/** Queue a webhook.test event and send it now (one attempt). A failed delivery is a 200 with ok:false and the reason. */
export async function sendTestEvent(client: RpcClientLike, userId: string, deps: DevDeps): Promise<Out> {
  const q = await rpc(client, "api_v2_webhook_enqueue_test", { p_user: userId, p_now: deps.now().toISOString() })
  const qd = q.ok ? obj(q.data) : null
  if (!qd) return UNAVAILABLE
  if (qd.error === "disabled") return { status: 409, body: { error: "Webhooks are not switched on yet.", code: "webhooks_off" } }
  if (qd.error === "no_endpoint") return { status: 404, body: { error: "Save a webhook URL first.", code: "no_endpoint" } }
  if (typeof qd.id !== "string") return UNAVAILABLE
  const c = await rpc(client, "api_v2_webhook_claim_one", { p_user: userId, p_event: qd.id, p_now: deps.now().toISOString() })
  const job = c.ok ? (obj(c.data) as unknown as Job | null) : null
  if (!job) return UNAVAILABLE
  const res = await deliverOne(client, job, deps)
  return { status: 200, body: { ok: res.ok, code: res.code, error: res.error, duration_ms: res.durationMs, event_id: qd.id } }
}

/** Newest first, 25 a page. cursor = "<created_at>|<evt id>" from the previous page's next; the time is passed unchanged. */
export async function listDeliveries(client: RpcClientLike, userId: string, cursor: string | null): Promise<Out> {
  let at: string | null = null
  let id: string | null = null
  if (cursor) {
    const m = CURSOR_RE.exec(cursor)
    if (!m) return bad("That page link is not valid. Start from the first page.")
    at = m[1]
    id = m[2]
  }
  const r = await rpc(client, "api_v2_webhook_deliveries", { p_user: userId, p_before_at: at, p_before_id: id, p_limit: PAGE })
  if (!r.ok || !Array.isArray(r.data)) return UNAVAILABLE
  const rows = r.data as Obj[]
  const last = rows[rows.length - 1]
  const next = rows.length === PAGE && last ? `${String(last.created_at)}|${String(last.id)}` : null
  return { status: 200, body: { rows, next } }
}

export async function resendDelivery(client: RpcClientLike, userId: string, eventId: string): Promise<Out> {
  if (typeof eventId !== "string" || !EVENT_RE.test(eventId)) return bad("Not a valid event id.")
  const r = await rpc(client, "api_v2_webhook_resend", { p_user: userId, p_event: eventId, p_now: new Date().toISOString() })
  const d = r.ok ? obj(r.data) : null
  if (!d) return UNAVAILABLE
  if (d.error === "not_found") return { status: 404, body: { error: "No such delivery.", code: "not_found" } }
  if (d.error === "pending") return { status: 409, body: { error: "That event is already queued.", code: "pending" } }
  if (d.error === "no_endpoint") return { status: 409, body: { error: "Save a webhook URL and turn it on first, then resend.", code: "no_endpoint" } }
  return { status: 200, body: { ok: true } }
}
