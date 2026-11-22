// Developer-side API access requests (api_v2_access_requests, migration 0195) and the alert de-duplication
// for live-key requests. The admin decides through the api_v2_* SQL functions.
import type { Environment, KeyType } from "./keys"
import { newRequestCode } from "./request-code"
import type { SupabaseLike } from "./store"

const TABLE = "api_v2_access_requests"
const DAY_MS = 24 * 60 * 60 * 1000
const CODE_ATTEMPTS = 3

type CreateResult =
  | { ok: true; id: string; code: string; alert: boolean }
  | { ok: false; status: 409 | 500 }
  | { ok: false; status: 429; retryAt: string }

interface RequestRow {
  status?: string
  created_at?: string | null
  decided_at?: string | null
}

const time = (v: string | null | undefined): number => (v ? Date.parse(v) : NaN)

/**
 * Opens a pending access request for `userId` (taken from the session by the caller, never the body).
 *  - 409 when one is already open (also when a concurrent request wins the one-pending-per-user index);
 *  - 429 for 24 h after a rejection, with the time a new request is allowed;
 *  - `alert` is false when this user already asked within 24 h (request, cancel, request), so admins are not spammed.
 */
export async function createAccessRequest(
  client: SupabaseLike,
  userId: string,
  now: Date,
  newCode: () => string = newRequestCode
): Promise<CreateResult> {
  try {
    const { data, error } = await client
      .from(TABLE)
      .select("status, created_at, decided_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(20)
    if (error || !Array.isArray(data)) return { ok: false, status: 500 }
    const rows = data as RequestRow[]

    if (rows.some((r) => r.status === "pending")) return { ok: false, status: 409 }

    const lastRejected = rows
      .filter((r) => r.status === "rejected")
      .map((r) => time(r.decided_at ?? r.created_at))
      .filter((t) => Number.isFinite(t))
      .sort((a, b) => b - a)[0]
    if (lastRejected !== undefined && now.getTime() - lastRejected < DAY_MS) {
      return { ok: false, status: 429, retryAt: new Date(lastRejected + DAY_MS).toISOString() }
    }

    const alert = !rows.some((r) => now.getTime() - time(r.created_at) < DAY_MS)

    for (let attempt = 1; attempt <= CODE_ATTEMPTS; attempt++) {
      const code = newCode()
      const { data: row, error: insertError } = await client
        .from(TABLE)
        .insert({ user_id: userId, request_code: code, status: "pending" })
        .select("id, request_code")
        .single()
      if (insertError) {
        const text = `${insertError.message ?? ""} ${insertError.details ?? ""}`
        if (insertError.code === "23505" && /request_code/.test(text)) continue
        return { ok: false, status: insertError.code === "23505" ? 409 : 500 }
      }
      if (!row || typeof row.id !== "string") return { ok: false, status: 500 }
      return { ok: true, id: row.id, code, alert }
    }
    return { ok: false, status: 500 }
  } catch {
    return { ok: false, status: 500 }
  }
}

/** Cancels the caller's own pending request. */
export async function cancelAccessRequest(client: SupabaseLike, userId: string): Promise<"cancelled" | "none" | "error"> {
  try {
    const { data, error } = await client
      .from(TABLE)
      .update({ status: "cancelled", decided_at: new Date().toISOString() })
      .eq("user_id", userId)
      .eq("status", "pending")
      .select("id")
    if (error) return "error"
    return Array.isArray(data) && data.length > 0 ? "cancelled" : "none"
  } catch {
    return "error"
  }
}

/**
 * Whether a new live-key request should alert admins and notify the owner: not when another key in the same
 * slot was requested in the last 24 h. A failed check alerts, so a request is never silently dropped.
 */
export async function shouldAlertForKey(
  client: SupabaseLike,
  p: { userId: string; type: KeyType; env: Environment; keyId: string; now: Date }
): Promise<boolean> {
  try {
    const { count, error } = await client
      .from("api_v2_keys")
      .select("id", { count: "exact", head: true })
      .eq("user_id", p.userId)
      .eq("key_type", p.type)
      .eq("environment", p.env)
      .neq("id", p.keyId)
      .gte("created_at", new Date(p.now.getTime() - DAY_MS).toISOString())
    if (error || typeof count !== "number") return true
    return count === 0
  } catch {
    return true
  }
}
