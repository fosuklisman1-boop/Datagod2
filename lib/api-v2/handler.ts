import { after, type NextRequest, type NextResponse } from "next/server"
import { applyRateLimit } from "@/lib/rate-limiter"
import { logReason } from "./log-reason"
import {
  extractKey,
  decideAccess,
  MSG_UNAUTHORIZED,
  MSG_RATE_LIMITED,
  MSG_UNAVAILABLE,
  MSG_ROLE_NOT_ALLOWED,
  MSG_PAUSED,
  MSG_SERVICE_PAUSED_DEFAULT,
} from "./access"
import { errorBody, successBody, v2Response, type V2ErrorStatus } from "./envelope"
import { hashV2Key, parseV2Key, type Environment, type KeyType } from "./keys"
import { resolveLimit, type LimitGroup } from "./limits"
import type { ControlsSnapshot } from "./controls"
import { blocksMethod, serviceForEndpoint } from "./services"
import {
  findKeyByHash,
  getAdminClient,
  getConfig,
  getUserForKey,
  hasGrant,
  logRequest,
  touchLastUsed,
  type V2KeyOwner,
  type V2KeyRow,
} from "./store"
import { getControls } from "./controls"

export interface V2Context {
  keyId: string
  userId: string
  role: string
  keyType: KeyType
  environment: Environment
  firstName: string | null
}

export interface V2Options {
  requiredType: KeyType
  group: LimitGroup
  endpoint: string
  /** Purchase endpoints set this: a degraded rate limiter returns 503 instead of letting the request through. */
  failClosedWhenLimiterDegraded?: boolean
}

export interface V2HandlerResult {
  status: number
  data?: unknown
  error?: { status: V2ErrorStatus; message: string }
}

export type V2Handler = (req: NextRequest, ctx: V2Context) => Promise<V2HandlerResult>

export interface V2Deps {
  store: {
    findKeyByHash(hash: string): Promise<V2KeyRow | null | "error">
    getUserForKey(userId: string): Promise<V2KeyOwner | null | "error">
    getConfig(): Promise<{ enabled: boolean; allowed_roles: string[] }>
    hasGrant(userId: string): Promise<boolean | "error">
    touchLastUsed(keyId: string): Promise<void>
    logRequest(p: Parameters<typeof logRequest>[1]): Promise<void>
  }
  rateLimit(
    request: NextRequest,
    name: string,
    max: number,
    windowMs: number,
    userId?: string,
    opts?: { pgFallback?: boolean }
  ): Promise<{ allowed: boolean; remaining: number; resetAt: number; degraded?: boolean; fallback?: boolean }>
  now(): Date
  /**
   * Developer and service pause snapshot (spec 6). Optional: without it nothing is ever paused (legacy tests).
   * Read only after decideAccess succeeded, so a denied caller learns nothing about pauses.
   */
  controls?: { read(): Promise<ControlsSnapshot | "error"> }
  /**
   * Runs post-response work (the request log and last_used touch). withV2 passes next's after(), so the
   * writes survive the function freezing. Optional: without it the work runs fire-and-forget.
   */
  schedule?(work: () => Promise<void>): void
}

/** Never throws and never affects the response: a throwing scheduler falls back to a caught fire-and-forget. */
function scheduleSafely(schedule: V2Deps["schedule"], work: () => Promise<void>): void {
  const fallback = () => {
    void work().catch(() => {})
  }
  if (!schedule) return fallback()
  try {
    schedule(work)
  } catch {
    fallback()
  }
}

export interface V2Input {
  headers: { get(name: string): string | null }
  method: string
  request: NextRequest
}

export interface V2Outcome {
  status: number
  body: object
}

function clientIp(headers: { get(name: string): string | null }): string {
  return (
    headers.get("x-vercel-forwarded-for")?.split(",")[0]?.trim() ||
    headers.get("x-forwarded-for")?.split(",").pop()?.trim() ||
    "unknown"
  )
}

function fail(status: V2ErrorStatus, message: string): V2Outcome {
  return { status, body: errorBody(status, message) }
}

export async function runV2(
  deps: V2Deps,
  opts: V2Options,
  handler: V2Handler,
  input: V2Input
): Promise<V2Outcome> {
  const start = deps.now().getTime()
  const unauthorized = () => fail(401, MSG_UNAUTHORIZED)

  const raw = extractKey(input.headers)
  if (!raw) return unauthorized()
  const parsed = parseV2Key(raw)
  if (!parsed) return unauthorized()

  /*
   * Check order (each step short-circuits):
   *   1. key header present and well-formed (401, no DB)
   *   2. key row found by hash (401, not logged)
   *   3. rate limit on the key's bucket (429, not logged, last_used not touched).
   *      Runs before any further lookup so denied requests (503, suspended, pending,
   *      revoked, wrong type, role) also consume the bucket and cannot be used to
   *      force unbounded DB reads/writes.
   *   4. key owner row found (401)
   *   5. decideAccess: config disabled 503 > suspended > key status > key type > role (logged);
   *      a role that is not allowed is retried once with the user's grant (read only then)
   *   6. (when deps.controls) developer pause 403 > service pause 503 (writes only); snapshot error 503
   *   7. handler; error results and non-2xx statuses map to the error envelope (logged)
   */
  const row = await deps.store.findKeyByHash(hashV2Key(raw))
  // A failed lookup is an outage, not a bad key: never tell a developer their key is invalid because our DB is down.
  if (row === "error") return fail(503, MSG_UNAVAILABLE)
  if (!row) return unauthorized()

  // Active keys share their owner's bucket; pending/revoked keys get a per-key bucket so a dead key cannot
  // burn the owner's quota. Degraded => allowed here (read-only endpoints). Purchase endpoints ask for the
  // Postgres fallback counter and fail closed below if even that is unavailable.
  const limit = await deps.rateLimit(
    input.request,
    `v2_${row.key_type}_${row.environment}_${opts.group}`,
    resolveLimit(opts.group, row.rate_limits),
    60000,
    row.status === "active" ? row.user_id : `key-${row.id}`,
    opts.failClosedWhenLimiterDegraded ? { pgFallback: true } : undefined
  )
  if (!limit.allowed) return fail(429, MSG_RATE_LIMITED)
  // Purchase endpoints fail closed: a degraded limiter (store unreachable, fallback cap) must not let money move.
  // Not logged and last_used not touched, same as the 429 above.
  if (opts.failClosedWhenLimiterDegraded && limit.degraded) return fail(503, MSG_UNAVAILABLE)

  const [user, config] = await Promise.all([deps.store.getUserForKey(row.user_id), deps.store.getConfig()])
  if (user === "error") return fail(503, MSG_UNAVAILABLE)
  if (!user) return unauthorized()

  const ip = clientIp(input.headers)
  const finish = (outcome: V2Outcome, errorCode?: number, message?: string): V2Outcome => {
    try {
      // Measured now, not when the scheduled work runs.
      const entry = {
        keyId: row.id,
        userId: row.user_id,
        method: input.method,
        endpoint: opts.endpoint,
        statusCode: outcome.status,
        errorCode,
        errorReason: logReason(outcome.status, message),
        ip,
        durationMs: deps.now().getTime() - start,
        environment: row.environment,
      }
      // One callback awaits both writes; neither failure stops the other and it never rejects.
      scheduleSafely(deps.schedule, async () => {
        await Promise.allSettled([
          Promise.resolve().then(() => deps.store.logRequest(entry)),
          Promise.resolve().then(() => deps.store.touchLastUsed(row.id)),
        ])
      })
    } catch {
      // logging must never affect the response
    }
    return outcome
  }
  const failLogged = (status: V2ErrorStatus, message: string) => finish(fail(status, message), status, message)

  const accessInput = {
    keyStatus: row.status,
    keyType: row.key_type,
    requiredType: opts.requiredType,
    configEnabled: config.enabled,
    allowedRoles: config.allowed_roles,
    userRole: user.role,
    suspended: user.suspended,
    hasGrant: false,
  }
  let access = decideAccess(accessInput)
  // Only when every other check passed and the role alone is not allowed: ask whether the person holds a
  // per-person grant. The allowed-role path never reads it, and an outage of the grants table can only
  // turn this one answer into 503, never a pending/revoked/wrong-type/suspended/disabled one.
  if (!access.ok && access.status === 403 && access.message === MSG_ROLE_NOT_ALLOWED) {
    const granted = await deps.store.hasGrant(row.user_id)
    if (granted === "error") return failLogged(503, MSG_UNAVAILABLE)
    if (granted) access = decideAccess({ ...accessInput, hasGrant: true })
  }
  if (!access.ok) return failLogged(access.status, access.message)

  if (deps.controls) {
    let controls: ControlsSnapshot | "error"
    try {
      controls = await deps.controls.read()
    } catch {
      controls = "error"
    }
    // A pause is a safety control: with no usable snapshot we do not guess "open".
    if (controls === "error") return failLogged(503, MSG_UNAVAILABLE)
    if (controls.pausedUsers.has(row.user_id)) return failLogged(403, MSG_PAUSED)
    const service = serviceForEndpoint(opts.endpoint)
    const paused = service ? controls.services.get(service) : undefined
    if (paused && blocksMethod(input.method)) {
      // The admin text is the response body only; the log message is the fixed marker (closed slug set).
      const text = paused.message?.trim() ? paused.message : MSG_SERVICE_PAUSED_DEFAULT
      return finish(fail(503, text), 503, MSG_SERVICE_PAUSED_DEFAULT)
    }
  }

  const ctx: V2Context = {
    keyId: row.id,
    userId: row.user_id,
    role: user.role,
    keyType: row.key_type,
    environment: row.environment,
    firstName: user.first_name,
  }

  let result: V2HandlerResult
  try {
    result = await handler(input.request, ctx)
  } catch {
    return failLogged(500, "Internal server error")
  }

  if (result.error) return failLogged(result.error.status, result.error.message)
  const status = result.status || 200
  // Success envelopes are only ever sent with a 2xx status.
  if (status < 200 || status > 299) return failLogged(500, "Internal server error")
  return finish({ status, body: successBody(result.data, deps.now()) })
}

export function withV2(
  opts: V2Options,
  handler: V2Handler
): (req: NextRequest) => Promise<NextResponse> {
  return async (req: NextRequest) => {
    const client = getAdminClient()
    const deps: V2Deps = {
      store: {
        findKeyByHash: (h) => findKeyByHash(client, h),
        getUserForKey: (id) => getUserForKey(client, id),
        getConfig: () => getConfig(client),
        hasGrant: (id) => hasGrant(client, id),
        touchLastUsed: (id) => touchLastUsed(client, id),
        logRequest: (p) => logRequest(client, p),
      },
      rateLimit: applyRateLimit,
      now: () => new Date(),
      controls: getControls(),
      schedule: (work) => after(work),
    }
    try {
      const out = await runV2(deps, opts, handler, { headers: req.headers, method: req.method, request: req })
      return v2Response(out.status, out.body)
    } catch {
      return v2Response(500, errorBody(500, "Internal server error"))
    }
  }
}
