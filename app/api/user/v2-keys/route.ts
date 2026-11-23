import { after, NextRequest, NextResponse } from "next/server"
import { applyRateLimit } from "@/lib/rate-limiter"
import { requireCapability } from "@/lib/roles/require-capability"
import { accessSummary, canIssue, isIssuableType, type AccessSummary } from "@/lib/api-v2/key-issue"
import type { Environment, KeyType } from "@/lib/api-v2/keys"
import { getOrCreateAccountForUser } from "@/lib/sms/account-service"
import { createKey, getAdminClient, getApprovalContact, getConfig, hasGrant } from "@/lib/api-v2/store"
import { shouldAlertForKey } from "@/lib/api-v2/access-requests"
import { resolveContact } from "@/lib/api-v2/approval-contact"
import { readSupportWhatsapp } from "@/lib/text-to-buy/call/support"
import { alertAdminsOfRequest, notifyUserOfOutcome } from "@/lib/admin-actions"

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

/** The account.api capability: "no" is a definite answer, "error" means the check itself failed. */
async function apiCapability(userId: string): Promise<"yes" | "no" | "error"> {
  const denied = await requireCapability(client, userId, "account.api")
  if (!denied) return "yes"
  return denied.status === 403 ? "no" : "error"
}

interface Caller {
  role: string
  suspended: boolean
  email: string | null
  /** Name and/or email, for the admin alert only. */
  label: string
}

/** The caller's role and suspension from the users row (never the token); null when it cannot be read. */
async function readCaller(userId: string): Promise<Caller | null> {
  try {
    const { data, error } = await client
      .from("users")
      .select("role, is_suspended, email, first_name, last_name")
      .eq("id", userId)
      .maybeSingle()
    if (error || !data) return null
    const email = typeof data.email === "string" && data.email ? data.email : null
    const name = [data.first_name, data.last_name].filter((s) => typeof s === "string" && s.trim()).join(" ").trim()
    return {
      role: typeof data.role === "string" ? data.role : "",
      suspended: Boolean(data.is_suspended),
      email,
      label: name && email ? `${name} (${email})` : name || email || "A user",
    }
  } catch {
    return null
  }
}

/** The WhatsApp number behind "Message admin": the API setting, else the support number. Never throws. */
async function approvalContact(): Promise<string | null> {
  try {
    const [configured, support] = await Promise.all([
      getApprovalContact(client).catch(() => null),
      readSupportWhatsapp(client).catch(() => null),
    ])
    return resolveContact(configured, support)
  } catch {
    return null
  }
}

interface Rejection {
  key_type: KeyType
  reason: string
  at: string
  /** The rejected request's code, so the developer can message the admin about it. */
  code: string | null
}

/** Runs post-response work with next's after(); without a request scope (tests) it runs caught, unawaited. */
function afterResponse(work: () => Promise<void>): void {
  const run = () => void work().catch(() => {})
  try {
    after(work)
  } catch {
    run()
  }
}

/**
 * The latest rejected live request per key type, unless a newer live request of that type is open
 * (the dashboard then shows that one instead). Informational: a failed read shows none.
 */
async function latestRejections(
  userId: string,
  open: Array<{ key_type: string; environment: string; created_at: string }>
): Promise<Rejection[]> {
  try {
    const { data, error } = await client
      .from("api_v2_keys")
      .select("key_type, reject_reason, rejected_at, request_code")
      .eq("user_id", userId)
      .eq("environment", "live")
      .eq("status", "revoked")
      // Only rejected keys: ordinary revoked keys (NULL rejected_at sort first) would otherwise fill the limit.
      .not("rejected_at", "is", null)
      .order("rejected_at", { ascending: false })
      .limit(30)
    if (error || !Array.isArray(data)) return []
    const out: Rejection[] = []
    type Row = { key_type: KeyType; reject_reason: string | null; rejected_at: string | null; request_code?: string | null }
    for (const r of data as Row[]) {
      const at = r.rejected_at
      if (!at || out.some((o) => o.key_type === r.key_type)) continue
      if (open.some((k) => k.key_type === r.key_type && k.environment === "live" && k.created_at > at)) continue
      out.push({ key_type: r.key_type, reason: r.reject_reason ?? "", at, code: r.request_code ?? null })
    }
    return out
  } catch {
    return []
  }
}

type AccessRequestView = { code: string; status: "pending" | "rejected"; reason: string | null; retryAt: string | null }

/** The caller's latest access request when it is open or rejected. Informational: a failed read shows none. */
async function latestAccessRequest(userId: string): Promise<AccessRequestView | null> {
  try {
    const { data, error } = await client
      .from("api_v2_access_requests")
      .select("request_code, status, reason, decided_at, created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(1)
    if (error || !Array.isArray(data) || !data[0]) return null
    const r = data[0] as { request_code: string; status: string; reason: string | null; decided_at: string | null }
    if (r.status === "pending") return { code: r.request_code, status: "pending", reason: null, retryAt: null }
    if (r.status === "rejected") {
      const decided = r.decided_at ? Date.parse(r.decided_at) : NaN
      const retryAt = Number.isFinite(decided) ? new Date(decided + 24 * 60 * 60 * 1000).toISOString() : null
      return { code: r.request_code, status: "rejected", reason: r.reason ?? null, retryAt }
    }
    return null
  } catch {
    return null
  }
}

/**
 * Alerts admins and tells the owner about a new live-key request, at most once per slot per 24 h.
 * Runs after the key exists; a failure here never changes the response.
 */
async function announceKeyRequest(
  userId: string,
  caller: Caller,
  row: { id: string; key_type: KeyType; request_code?: string | null },
  swap: boolean
): Promise<void> {
  try {
    if (!(await shouldAlertForKey(client, { userId, type: row.key_type, env: "live", keyId: row.id, now: new Date() }))) return
    const code = row.request_code ?? undefined
    const kind = swap ? "swap" : "key"
    await alertAdminsOfRequest("api_access", { kind, code, keyType: row.key_type, who: caller.label })
    await notifyUserOfOutcome("api_access", "requested", { userId, reference: code }, { kind, code, keyType: row.key_type })
  } catch {
    // notifications never undo or fail the request
  }
}

/**
 * Whether the caller may generate keys, by the same rule as POST (canRequestKey): a grant satisfies both
 * the allowed-role and the account.api requirement. The grant is read ONLY when the role or capability
 * alone would not allow it, and only after enabled/suspended have passed, so a grants outage can change
 * nothing else. Any failed read (users row, capability, grant) is `null` so the route answers with an error
 * (the dashboard shows Retry): never "not eligible", never allowed.
 */
async function callerAccess(userId: string): Promise<{ access: AccessSummary; caller: Caller } | null> {
  const [caller, config, capability] = await Promise.all([readCaller(userId), getConfig(client), apiCapability(userId)])
  if (!caller || capability === "error") return null
  const base = { role: caller.role, suspended: caller.suspended, enabled: config.enabled, allowedRoles: config.allowed_roles }
  // Optimistic pass settles disabled and suspended without touching the grants table.
  const optimistic = accessSummary({ ...base, hasGrant: true, hasApiCapability: true })
  if (!optimistic.canGenerate) return { access: optimistic, caller }
  const needGrant = capability === "no" || !config.allowed_roles.includes(caller.role)
  if (!needGrant) return { access: optimistic, caller }
  const granted = await hasGrant(client, userId)
  if (granted === "error") return null
  return { access: accessSummary({ ...base, hasGrant: granted, hasApiCapability: capability === "yes" }), caller }
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

  const [{ data: keys, error }, caller, smsAvailable, contact, accessRequest] = await Promise.all([
    client
      .from("api_v2_keys")
      .select("id, key_type, environment, status, key_prefix, last_used_at, created_at, request_code")
      .eq("user_id", sessionUser.id)
      .in("status", ["pending", "active"])
      .order("created_at", { ascending: false }),
    callerAccess(sessionUser.id),
    callerSmsAvailable(sessionUser.id),
    approvalContact(),
    latestAccessRequest(sessionUser.id),
  ])

  if (error) return NextResponse.json({ error: "Failed to fetch API keys" }, { status: 500 })
  if (!caller) return NextResponse.json({ error: "Couldn't check your access. Please try again." }, { status: 503 })
  const list = Array.isArray(keys) ? keys : []
  const rejections = await latestRejections(sessionUser.id, list)
  return NextResponse.json({
    keys: list,
    access: caller.access,
    smsAvailable,
    approval: { contact, email: caller.caller.email },
    rejections,
    accessRequest,
  })
}

/** POST /api/user/v2-keys - issue a key. The full key is returned once. */
export async function POST(request: NextRequest) {
  const sessionUser = await getSessionUser(request)
  if (!sessionUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  // A missing capability is not final here: a per-person grant satisfies it, so only a failed check stops now.
  const capability = await apiCapability(sessionUser.id)
  if (capability === "error") {
    return NextResponse.json({ error: "Couldn't check your access. Please try again." }, { status: 503 })
  }

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
  // An unreadable row is unknown suspension: refuse (503) rather than let a grant carry a suspended account.
  const caller = await readCaller(sessionUser.id)
  if (!caller) {
    return NextResponse.json({ error: "Couldn't check your access. Please try again." }, { status: 503 })
  }
  const { role, suspended } = caller

  const config = await getConfig(client)
  const base = {
    enabled: config.enabled,
    type: keyType,
    role,
    allowedRoles: config.allowed_roles,
    suspended,
  }
  // Optimistic pass first (as if granted): it settles disabled, bad type and suspended without reading the
  // grants table. Only when it passes and the role/capability alone would not allow it is the grant read,
  // and the decision is re-made with the real answer. A failed grant read is 503, never allowed.
  let holdsGrant = true
  let decision = canIssue({ ...base, hasGrant: true, hasApiCapability: true, hasSmsAccess: true })
  if (decision.ok && (capability === "no" || !config.allowed_roles.includes(role))) {
    const granted = await hasGrant(client, sessionUser.id)
    if (granted === "error") {
      return NextResponse.json({ error: "Couldn't check your access. Please try again." }, { status: 503 })
    }
    holdsGrant = granted
    decision = canIssue({ ...base, hasGrant: granted, hasApiCapability: capability === "yes", hasSmsAccess: true })
  }
  const eligibility = { hasGrant: holdsGrant, hasApiCapability: capability === "yes" }
  // SMS access is resolved (and the SMS account created, as v1 does) ONLY for an sms request that
  // already passed every other check, then the decision is re-made with the real answer.
  if (decision.ok && keyType === "sms") {
    let hasSmsAccess = false
    try {
      hasSmsAccess = (await getOrCreateAccountForUser(sessionUser.id)) !== null
    } catch {
      hasSmsAccess = false
    }
    decision = canIssue({ ...base, ...eligibility, hasSmsAccess })
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
  // The full key is in this response and is shown only once: never make it wait on email/SMS/push.
  if (row.environment === "live") afterResponse(() => announceKeyRequest(sessionUser.id, caller, row, result.hadActive))
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
      request_code: row.request_code ?? null,
    },
    { status: 201 }
  )
}

/** DELETE /api/user/v2-keys?id= - revoke one of the caller's own keys. Revoked is terminal. */
export async function DELETE(request: NextRequest) {
  const sessionUser = await getSessionUser(request)
  if (!sessionUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const params = new URL(request.url).searchParams
  const keyId = params.get("id")
  if (!keyId) return NextResponse.json({ error: "Key ID is required" }, { status: 400 })
  // "Cancel request" on a waiting replacement: only a still-pending key may go. If an admin approved it a moment
  // ago it is now the working key, and revoking it would leave the developer with no live key.
  const onlyPending = params.get("only") === "pending"

  const now = new Date().toISOString()
  const { data, error } = await client
    .from("api_v2_keys")
    .update({ status: "revoked", revoked_at: now, revoked_by: sessionUser.id, updated_at: now })
    .eq("id", keyId)
    .eq("user_id", sessionUser.id)
    .in("status", onlyPending ? ["pending"] : ["pending", "active"])
    .select("id")

  if (error) return NextResponse.json({ error: "Failed to revoke API key" }, { status: 500 })
  if (!Array.isArray(data) || data.length === 0) {
    if (onlyPending) {
      return NextResponse.json({ error: "This request was already approved or removed. Refresh the page." }, { status: 409 })
    }
    return NextResponse.json({ error: "Key not found" }, { status: 404 })
  }
  return NextResponse.json({ message: "API key revoked successfully" })
}
