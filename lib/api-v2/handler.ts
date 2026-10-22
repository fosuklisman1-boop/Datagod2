import type { NextRequest, NextResponse } from "next/server"
import { applyRateLimit } from "@/lib/rate-limiter"
import { extractKey, decideAccess } from "./access"
import { errorBody, successBody, v2Response, type V2ErrorStatus } from "./envelope"
import { hashV2Key, parseV2Key, type Environment, type KeyType } from "./keys"
import { resolveLimit, type LimitGroup } from "./limits"
import {
  findKeyByHash,
  getAdminClient,
  getConfig,
  getUserForKey,
  logRequest,
  touchLastUsed,
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
    getUserForKey(userId: string): Promise<{ id: string; role: string; first_name: string | null; email: string | null } | null>
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
  const unauthorized = () => fail(401, "Invalid or missing API key")

  const raw = extractKey(input.headers)
  if (!raw) return unauthorized()
  const parsed = parseV2Key(raw)
  if (!parsed) return unauthorized()

  const row = await deps.store.findKeyByHash(hashV2Key(raw))
  if (!row) return unauthorized()

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
  })
  if (!access.ok) return failLogged(access.status, access.message)

  const limit = await deps.rateLimit(
    input.request,
    `v2_${row.key_type}_${opts.group}`,
    resolveLimit(opts.group, row.rate_limits),
    60000,
    row.user_id
  )
  if (!limit.allowed) return failLogged(429, "Rate limit exceeded")

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
    }
    try {
      const out = await runV2(deps, opts, handler, { headers: req.headers, method: req.method, request: req })
      return v2Response(out.status, out.body)
    } catch {
      return v2Response(500, errorBody(500, "Internal server error"))
    }
  }
}
