import { createClient } from "@supabase/supabase-js"
import { generateV2Key, type Environment, type KeyStatus, type KeyType } from "./keys"
import { initialStatus } from "./lifecycle"

/**
 * Minimal structural type: the real service-role Supabase client satisfies it,
 * and tests inject a hand-rolled fake. Only `.from(table)` chains are used.
 */
export interface SupabaseLike {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from(table: string): any
}

/** A key row as returned to callers. Never carries key_hash. */
export interface V2KeyRow {
  id: string
  user_id: string
  key_type: KeyType
  environment: Environment
  status: KeyStatus
  name: string
  key_prefix: string
  rate_limits: unknown
  last_used_at: string | null
  created_at: string
}

const KEY_COLUMNS =
  "id, user_id, key_type, environment, status, name, key_prefix, rate_limits, last_used_at, created_at"

export function getAdminClient(): SupabaseLike {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

export async function findKeyByHash(client: SupabaseLike, hash: string): Promise<V2KeyRow | null> {
  try {
    const { data, error } = await client
      .from("api_v2_keys")
      .select(KEY_COLUMNS)
      .eq("key_hash", hash)
      .maybeSingle()
    if (error || !data) return null
    return data as V2KeyRow
  } catch {
    return null
  }
}

export async function getUserForKey(
  client: SupabaseLike,
  userId: string
): Promise<{ id: string; role: string; first_name: string | null; email: string | null } | null> {
  try {
    const { data, error } = await client
      .from("users")
      .select("id, role, first_name, email")
      .eq("id", userId)
      .maybeSingle()
    if (error || !data) return null
    return data
  } catch {
    return null
  }
}

/** Fails closed: any error or missing row means the API is disabled for everyone. */
export async function getConfig(client: SupabaseLike): Promise<{ enabled: boolean; allowed_roles: string[] }> {
  const closed = { enabled: false, allowed_roles: [] as string[] }
  try {
    const { data, error } = await client
      .from("api_v2_config")
      .select("enabled, allowed_roles")
      .eq("id", true)
      .maybeSingle()
    if (error || !data) return closed
    return {
      enabled: data.enabled === true,
      allowed_roles: Array.isArray(data.allowed_roles) ? data.allowed_roles : [],
    }
  } catch {
    return closed
  }
}

export async function createKey(
  client: SupabaseLike,
  p: { userId: string; type: KeyType; env: Environment; name?: string }
): Promise<{ ok: true; key: string; row: V2KeyRow } | { ok: false; status: 409 | 500 }> {
  try {
    const now = new Date().toISOString()
    // Revoke any existing pending/active key for this (user, type, env) first.
    const { error: revokeError } = await client
      .from("api_v2_keys")
      .update({ status: "revoked", revoked_at: now, updated_at: now })
      .eq("user_id", p.userId)
      .eq("key_type", p.type)
      .eq("environment", p.env)
      .in("status", ["pending", "active"])
    if (revokeError) return { ok: false, status: 500 }

    const { key, prefix, hash } = generateV2Key(p.type, p.env)
    const name = p.name || `${p.env === "live" ? "Live" : "Test"} ${p.type} key`
    const { data, error } = await client
      .from("api_v2_keys")
      .insert({
        user_id: p.userId,
        key_type: p.type,
        environment: p.env,
        status: initialStatus(p.env),
        name,
        key_hash: hash,
        key_prefix: prefix,
      })
      .select(KEY_COLUMNS)
      .single()
    if (error) return { ok: false, status: error.code === "23505" ? 409 : 500 }
    if (!data) return { ok: false, status: 500 }
    // Defensive: never hand key_hash back, whatever the client returned.
    const { key_hash: _omit, ...row } = data as V2KeyRow & { key_hash?: string }
    void _omit
    return { ok: true, key, row }
  } catch {
    return { ok: false, status: 500 }
  }
}

export async function touchLastUsed(client: SupabaseLike, keyId: string): Promise<void> {
  try {
    await client.from("api_v2_keys").update({ last_used_at: new Date().toISOString() }).eq("id", keyId)
  } catch {
    // never throws
  }
}

export async function logRequest(
  client: SupabaseLike,
  p: {
    keyId: string
    userId: string
    method: string
    endpoint: string
    statusCode: number
    errorCode?: number
    ip: string
    durationMs: number
    environment: Environment
  }
): Promise<void> {
  try {
    await client.from("api_v2_logs").insert({
      key_id: p.keyId,
      user_id: p.userId,
      method: p.method,
      endpoint: p.endpoint,
      status_code: p.statusCode,
      error_code: p.errorCode ?? null,
      ip_address: p.ip,
      duration_ms: p.durationMs,
      environment: p.environment,
    })
  } catch {
    // never throws
  }
}

/** Kill switch: revoke every pending/active v2 key. Returns how many were revoked. */
export async function revokeAllV2Keys(client: SupabaseLike): Promise<number> {
  const now = new Date().toISOString()
  const { data, error } = await client
    .from("api_v2_keys")
    .update({ status: "revoked", revoked_at: now, updated_at: now })
    .in("status", ["pending", "active"])
    .select("id")
  if (error) throw new Error("Failed to revoke v2 keys")
  return Array.isArray(data) ? data.length : 0
}
