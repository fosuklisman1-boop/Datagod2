// Release 6 webhook delivery cycle (cron /api/cron/api-v2-webhooks, every minute): scan for new events, claim due ones,
// send each through the SSRF guard, record the result. One job failing never stops the others. Error texts are short
// fixed phrases: never a host, address, or exception message (those can carry internal detail).
import { checkUrlSyntax, resolveSafe, type LookupAll } from "./url-guard"
import { buildDelivery, snippetOf, type PostRequest } from "./send"

export interface Job {
  id: string
  user_id: string
  type: string
  payload: unknown
  attempt: number
  url: string
  secret: string
}

export interface CycleDeps {
  now(): Date
  resolve: LookupAll
  post(p: PostRequest): Promise<{ status: number; body: string }>
}

export interface RpcClientLike {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>
}

export interface DeliveryResult {
  ok: boolean
  code: number | null
  durationMs: number
  error: string | null
  snippet: string | null
}

const TIMEOUT_MS = 10_000

async function attempt(job: Job, deps: CycleDeps): Promise<DeliveryResult> {
  const started = Date.now()
  const fail = (error: string, code: number | null = null, snippet: string | null = null): DeliveryResult => ({
    ok: false,
    code,
    durationMs: Date.now() - started,
    error,
    snippet,
  })
  const syntax = checkUrlSyntax(job.url)
  if (!syntax.ok) return fail(syntax.error)
  const addr = await resolveSafe(syntax.host, deps.resolve)
  if (!addr.ok) return fail(addr.error)
  const d = buildDelivery(job, Math.floor(deps.now().getTime() / 1000))
  try {
    const res = await deps.post({ url: syntax.url, headers: d.headers, body: d.body, address: addr.address, family: addr.family, timeoutMs: TIMEOUT_MS })
    const snippet = snippetOf(res.body)
    if (res.status >= 200 && res.status < 300) return { ok: true, code: res.status, durationMs: Date.now() - started, error: null, snippet }
    if (res.status >= 300 && res.status < 400) return fail(`Redirects are not followed (HTTP ${res.status}).`, res.status, snippet)
    return fail(`HTTP ${res.status}`, res.status || null, snippet)
  } catch (e) {
    return fail(e instanceof Error && e.name === "TimeoutError" ? "Timed out after 10 seconds." : "Connection failed.")
  }
}

/** Send one claimed job and record the attempt. Never throws. */
export async function deliverOne(client: RpcClientLike, job: Job, deps: CycleDeps): Promise<DeliveryResult> {
  let r: DeliveryResult
  try {
    r = await attempt(job, deps)
  } catch {
    r = { ok: false, code: null, durationMs: 0, error: "Delivery failed.", snippet: null }
  }
  try {
    await client.rpc("api_v2_webhook_record", {
      p_event: job.id,
      p_attempt: job.attempt,
      p_ok: r.ok,
      p_code: r.code,
      p_duration_ms: r.durationMs,
      p_error: r.error,
      p_snippet: r.snippet,
      p_now: deps.now().toISOString(),
    })
  } catch {
    // the lease expires in 3 minutes and the event is retried
  }
  return r
}

export async function runWebhookCycle(
  client: RpcClientLike,
  deps: CycleDeps,
  opts: { scanLimit?: number; claimLimit?: number; concurrency?: number } = {},
): Promise<{ scanned: number; sent: number; delivered: number; failed: number }> {
  let scanned = 0
  try {
    const s = await client.rpc("api_v2_webhook_scan", { p_now: deps.now().toISOString(), p_limit: opts.scanLimit ?? 500 })
    if (!s.error && typeof s.data === "number") scanned = s.data
    else if (s.error) console.error("[api-v2-webhooks] scan failed")
  } catch {
    console.error("[api-v2-webhooks] scan failed")
  }
  const c = await client.rpc("api_v2_webhook_claim", { p_now: deps.now().toISOString(), p_limit: opts.claimLimit ?? 50 })
  if (c.error) throw new Error("webhook claim failed")
  const jobs = (Array.isArray(c.data) ? c.data : []) as Job[]
  let delivered = 0
  let failed = 0
  let next = 0
  const lane = async () => {
    while (next < jobs.length) {
      const j = jobs[next++]
      const r = await deliverOne(client, j, deps)
      if (r.ok) delivered++
      else failed++
    }
  }
  await Promise.all(Array.from({ length: Math.min(opts.concurrency ?? 10, jobs.length) }, lane))
  return { scanned, sent: jobs.length, delivered, failed }
}
