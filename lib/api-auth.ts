import { NextRequest } from "next/server"
import { createClient } from "@supabase/supabase-js"
import crypto from "crypto"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export interface ApiUser {
  id: string
  email: string
  role: string
  first_name: string
  api_key_id: string
}

/**
 * Hash an API key using SHA-256 for secure storage
 */
export function hashApiKey(key: string): string {
  return crypto.createHash("sha256").update(key).digest("hex")
}

/**
 * Generate a new API key with the dg_live_ prefix
 */
export function generateApiKey(): { key: string; prefix: string; hash: string } {
  const random = crypto.randomBytes(32).toString("hex")
  const key = `dg_live_${random}`
  const prefix = key.substring(0, 16) // "dg_live_" + first 8 chars
  const hash = hashApiKey(key)
  return { key, prefix, hash }
}

/**
 * Authenticate an incoming API request via the X-API-Key header.
 * Returns the authenticated user or null.
 */
export async function authenticateApiKey(request: NextRequest): Promise<ApiUser | null> {
  const apiKey = request.headers.get("X-API-Key") || request.headers.get("x-api-key")
  if (!apiKey || !apiKey.startsWith("dg_live_")) {
    return null
  }

  const keyHash = hashApiKey(apiKey)

  // Look up the hashed key
  const { data: keyRecord, error } = await supabase
    .from("user_api_keys")
    .select("id, user_id, is_active, last_used_at")
    .eq("key_hash", keyHash)
    .eq("is_active", true)
    .single()

  if (error || !keyRecord) {
    return null
  }

  // Fetch user details
  const { data: user } = await supabase
    .from("users")
    .select("id, email, role, first_name")
    .eq("id", keyRecord.user_id)
    .single()

  if (!user) {
    return null
  }

  // Update last_used_at asynchronously (non-blocking)
  supabase
    .from("user_api_keys")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", keyRecord.id)
    .then(() => {})

  return {
    id: user.id,
    email: user.email,
    role: user.role,
    first_name: user.first_name,
    api_key_id: keyRecord.id,
  }
}

/**
 * Log an API request to the audit log
 */
export async function logApiRequest({
  userId,
  apiKeyId,
  method,
  endpoint,
  statusCode,
  request,
  durationMs,
}: {
  userId: string
  apiKeyId: string
  method: string
  endpoint: string
  statusCode: number
  request: NextRequest
  durationMs?: number
}): Promise<void> {
  const ip =
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-real-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0] ||
    "unknown"

  await supabase.from("user_api_logs").insert({
    user_id: userId,
    api_key_id: apiKeyId,
    method,
    endpoint,
    status_code: statusCode,
    ip_address: ip,
    user_agent: request.headers.get("user-agent"),
    duration_ms: durationMs,
    created_at: new Date().toISOString(),
  })
}
