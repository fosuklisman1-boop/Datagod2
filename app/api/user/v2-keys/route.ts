import { NextRequest, NextResponse } from "next/server"
import { applyRateLimit } from "@/lib/rate-limiter"
import { accessSummary, canIssue, isIssuableType, type AccessSummary } from "@/lib/api-v2/key-issue"
import type { Environment } from "@/lib/api-v2/keys"
import { getOrCreateAccountForUser } from "@/lib/sms/account-service"
import { createKey, getAdminClient, getConfig } from "@/lib/api-v2/store"

// Service-role client; callers are authenticated via their session bearer token.
const client = getAdminClient()
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const authClient = client as any

async function getSessionUser(request: NextRequest): Promise<{ id: string } | null> {
  const token = request.headers.get("Authorization")?.replace("Bearer ", "")
  if (!token) return null
  const { data } = await authClient.auth.getUser(token)
  return data?.user ?? null
}

/**
 * Whether the caller may generate keys, derived exactly like POST: role and suspension from the
 * users row (never the token), enabled/allowed roles from getConfig (which already fails closed to
 * disabled). If the users row cannot be read the role is treated as unknown, so the answer is
 * `role_not_allowed` (or `disabled` when v2 is off): fail closed, never `ok`.
 */
async function callerAccess(userId: string): Promise<AccessSummary> {
  let role = ""
  let suspended = false
  try {
    const { data: userRow, error } = await client
      .from("users")
      .select("role, is_suspended")
      .eq("id", userId)
      .maybeSingle()
    if (!error && userRow) {
      role = typeof userRow.role === "string" ? userRow.role : ""
      suspended = Boolean(userRow.is_suspended)
    }
  } catch {
    role = ""
  }
  const config = await getConfig(client)
  return accessSummary({ role, suspended, enabled: config.enabled, allowedRoles: config.allowed_roles })
}

/**
 * Whether the caller already has an SMS account, by a READ-ONLY lookup (a GET must never create one).
 * Any failure reads as "not available": the dashboard then simply does not offer the SMS key.
 */
async function callerSmsAvailable(userId: string): Promise<boolean> {
  try {
    const { data, error } = await client.from("sms_accounts").select("id").eq("user_id", userId).maybeSingle()
    return !error && Boolean(data)
  } catch {
    return false
  }
}

/** GET /api/user/v2-keys - list the caller's non-revoked v2 keys plus whether they may generate. */
export async function GET(request: NextRequest) {
  const sessionUser = await getSessionUser(request)
  if (!sessionUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const [{ data: keys, error }, access, smsAvailable] = await Promise.all([
    client
      .from("api_v2_keys")
      .select("id, key_type, environment, status, key_prefix, last_used_at, created_at")
      .eq("user_id", sessionUser.id)
      .in("status", ["pending", "active"])
      .order("created_at", { ascending: false }),
    callerAccess(sessionUser.id),
    callerSmsAvailable(sessionUser.id),
  ])

  if (error) return NextResponse.json({ error: "Failed to fetch API keys" }, { status: 500 })
  return NextResponse.json({ keys, access, smsAvailable })
}

/** POST /api/user/v2-keys - issue a key. The full key is returned once. */
export async function POST(request: NextRequest) {
  const sessionUser = await getSessionUser(request)
  if (!sessionUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const rateLimit = await applyRateLimit(request, "api_v2_key_generate", 10, 60 * 60 * 1000, sessionUser.id)
  if (!rateLimit.allowed) return NextResponse.json({ error: "Too many requests" }, { status: 429 })
  const ipRateLimit = await applyRateLimit(request, "api_v2_key_generate_ip", 20, 60 * 60 * 1000)
  if (!ipRateLimit.allowed) {
    return NextResponse.json(
      { error: "Too many key generations from this network. Please slow down." },
      { status: 429 }
    )
  }

  const body = await request.json().catch(() => ({}))
  const environment: Environment | null =
    body?.environment === "test" ? "test" : body?.environment === "live" ? "live" : null
  if (!environment) {
    return NextResponse.json({ error: "environment must be 'test' or 'live'" }, { status: 400 })
  }
  const keyType = typeof body?.key_type === "string" ? body.key_type : ""

  // Role and suspension come from the users table, never from the request or token metadata.
  const { data: userRow } = await client
    .from("users")
    .select("role, is_suspended")
    .eq("id", sessionUser.id)
    .maybeSingle()
  const role = typeof userRow?.role === "string" ? userRow.role : ""
  const suspended = Boolean(userRow?.is_suspended)

  const config = await getConfig(client)
  const base = { enabled: config.enabled, type: keyType, role, allowedRoles: config.allowed_roles, suspended }
  let decision = canIssue({ ...base, hasSmsAccess: true })
  // SMS access is resolved (and the SMS account created, as v1 does) ONLY for an sms request that
  // already passed every other check, then the decision is re-made with the real answer.
  if (decision.ok && keyType === "sms") {
    let hasSmsAccess = false
    try {
      hasSmsAccess = (await getOrCreateAccountForUser(sessionUser.id)) !== null
    } catch {
      hasSmsAccess = false
    }
    decision = canIssue({ ...base, hasSmsAccess })
  }
  if (!decision.ok || !isIssuableType(keyType)) {
    const d = decision.ok ? { status: 400, message: "Invalid key_type" } : decision
    return NextResponse.json({ error: d.message }, { status: d.status })
  }

  const result = await createKey(client, { userId: sessionUser.id, type: keyType, env: environment })
  if (!result.ok) {
    if (result.status === 409) {
      return NextResponse.json({ error: "A key is already being generated, please retry" }, { status: 409 })
    }
    return NextResponse.json({ error: "Failed to create API key" }, { status: 500 })
  }

  const { row } = result
  return NextResponse.json(
    {
      message: "API key created. Save this key securely — it will not be shown again.",
      key: result.key,
      id: row.id,
      key_type: row.key_type,
      environment: row.environment,
      status: row.status,
      key_prefix: row.key_prefix,
      created_at: row.created_at,
    },
    { status: 201 }
  )
}

/** DELETE /api/user/v2-keys?id= - revoke one of the caller's own keys. Revoked is terminal. */
export async function DELETE(request: NextRequest) {
  const sessionUser = await getSessionUser(request)
  if (!sessionUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const keyId = new URL(request.url).searchParams.get("id")
  if (!keyId) return NextResponse.json({ error: "Key ID is required" }, { status: 400 })

  const now = new Date().toISOString()
  const { data, error } = await client
    .from("api_v2_keys")
    .update({ status: "revoked", revoked_at: now, revoked_by: sessionUser.id, updated_at: now })
    .eq("id", keyId)
    .eq("user_id", sessionUser.id)
    .in("status", ["pending", "active"])
    .select("id")

  if (error) return NextResponse.json({ error: "Failed to revoke API key" }, { status: 500 })
  if (!Array.isArray(data) || data.length === 0) {
    return NextResponse.json({ error: "Key not found" }, { status: 404 })
  }
  return NextResponse.json({ message: "API key revoked successfully" })
}
