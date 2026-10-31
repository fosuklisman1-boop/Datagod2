import type { NextRequest, NextResponse } from "next/server"
import { applyRateLimit } from "@/lib/rate-limiter"
import { extractKey, decideAccess, MSG_UNAUTHORIZED, MSG_RATE_LIMITED, MSG_UNAVAILABLE } from "./access"
import { errorBody, successBody, v2Response, type V2ErrorStatus } from "./envelope"
import { hashV2Key, parseV2Key, type Environment, type KeyType } from "./keys"
import { resolveLimit, type LimitGroup } from "./limits"
import { v2FallbackLimiter, type FallbackLimiter } from "./fallback-limiter"
import {
  findKeyByHash,
  getAdminClient,
  getConfig,
  getUserForKey,
  logRequest,
  touchLastUsed,
  type V2KeyOwner,
  type V2KeyRow,
} from "./store"

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
  /**
   * Purchase and lookup endpoints set this. Redis being missing or down never blocks them: when the
   * shared limiter is degraded, the key's own limit is enforced by an in-process limiter (429 past it)
   * instead of letting requests through uncapped. Without a fallback limiter in deps the request
   * fails closed (503); withV2 always wires one.
   */
  fallbackLimitWhenDegraded?: boolean
}

export interface V2HandlerResult {
  status: number
  data?: unknown
  error?: { status: V2ErrorStatus; message: string }
}

export type V2Handler = (req: NextRequest, ctx: V2Context) => Promise<V2HandlerResult>

export interface V2Deps {
  store: {
    findKeyByHash(hash: string): Promise<V2KeyRow | null>
    getUserForKey(userId: string): Promise<V2KeyOwner | null>
    getConfig(): Promise<{ enabled: boolean; allowed_roles: string[] }>
    touchLastUsed(keyId: string): Promise<void>
    logRequest(p: Parameters<typeof logRequest>[1]): Promise<void>
  }
  rateLimit(
    request: NextRequest,
    name: string,
    max: number,
    windowMs: number,
    userId?: string
  ): Promise<{ allowed: boolean; remaining: number; resetAt: number; degraded?: boolean }>
  now(): Date
  /** In-process limiter used by `fallbackLimitWhenDegraded`. */
  fallbackLimiter?: FallbackLimiter
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
   *   5. decideAccess: config disabled 503 > suspended > key status > key type > role (logged)
   *   6. handler; error results and non-2xx statuses map to the error envelope (logged)
   */
  const row = await deps.store.findKeyByHash(hashV2Key(raw))
  if (!row) return unauthorized()

  // degraded => allowed here (read-only endpoints); purchase endpoints use the in-process fallback cap below.
  const bucket = `v2_${row.key_type}_${row.environment}_${opts.group}`
  const max = resolveLimit(opts.group, row.rate_limits)
  const limit = await deps.rateLimit(input.request, bucket, max, 60000, row.user_id)
  if (!limit.allowed) return fail(429, MSG_RATE_LIMITED)
  // Redis missing or down must not block anything, and must not leave money endpoints uncapped:
  // cap each key in-process instead. Not logged and last_used not touched, same as the 429 above.
  if (opts.fallbackLimitWhenDegraded && limit.degraded) {
    if (!deps.fallbackLimiter) return fail(503, MSG_UNAVAILABLE)
    if (!deps.fallbackLimiter.hit(`${bucket}:${row.id}`, max, 60000, deps.now().getTime())) {
      return fail(429, MSG_RATE_LIMITED)
    }
  }

  const [user, config] = await Promise.all([deps.store.getUserForKey(row.user_id), deps.store.getConfig()])
  if (!user) return unauthorized()

  const ip = clientIp(input.headers)
  const finish = (outcome: V2Outcome, errorCode?: number): V2Outcome => {
    // Fire and forget; the store functions never throw, the catch is belt and braces.
    try {
      void deps.store
        .logRequest({
          keyId: row.id,
          userId: row.user_id,
          method: input.method,
          endpoint: opts.endpoint,
          statusCode: outcome.status,
          errorCode,
          ip,
          durationMs: deps.now().getTime() - start,
          environment: row.environment,
        })
        .catch(() => {})
      void deps.store.touchLastUsed(row.id).catch(() => {})
    } catch {
      // ignore
    }
    return outcome
  }
  const failLogged = (status: V2ErrorStatus, message: string) => finish(fail(status, message), status)

  const access = decideAccess({
    keyStatus: row.status,
    keyType: row.key_type,
    requiredType: opts.requiredType,
    configEnabled: config.enabled,
    allowedRoles: config.allowed_roles,
    userRole: user.role,
    suspended: user.suspended,
  })
  if (!access.ok) return failLogged(access.status, access.message)

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
        touchLastUsed: (id) => touchLastUsed(client, id),
        logRequest: (p) => logRequest(client, p),
      },
      rateLimit: applyRateLimit,
      now: () => new Date(),
      fallbackLimiter: v2FallbackLimiter,
    }
    try {
      const out = await runV2(deps, opts, handler, { headers: req.headers, method: req.method, request: req })
      return v2Response(out.status, out.body)
    } catch {
      return v2Response(500, errorBody(500, "Internal server error"))
    }
  }
}
