// lib/roles/admin/route-helpers.ts
// Shared plumbing for the /api/admin/roles hub routes.
import { createClient, type SupabaseClient } from "@supabase/supabase-js"
import { NextResponse, type NextRequest } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"

export type HubAdmin = { adminId: string; db: SupabaseClient }

const json = (body: unknown, status: number) => NextResponse.json(body, { status })

/**
 * Admin gate for every hub route (reads included). verifyAdminAccess lets the CRON_SECRET bearer through with
 * isAdmin true and NO userId; every hub write needs a real actor for the audit log, so that case is refused.
 */
export async function requireHubAdmin(request: NextRequest): Promise<HubAdmin | { response: NextResponse }> {
  const auth = await verifyAdminAccess(request)
  if (auth.errorResponse) return { response: auth.errorResponse }
  if (!auth.isAdmin) return { response: json({ error: "Admin access required" }, 403) }
  if (!auth.userId) return { response: json({ error: "Admin user required" }, 403) }
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
  return { adminId: auth.userId, db }
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function badRequest(message: string) {
  return json({ error: message }, 400)
}
export function conflict(message: string) {
  return json({ error: message }, 409)
}
export function serverError() {
  return json({ error: "Something went wrong" }, 500)
}

// Known RAISE texts from migrations/0187_roles_hub.sql. Matched by substring; anything else is a 500.
const CONFLICT_PATTERNS = ["role has members", "is already in use", "slug already in use"]
const BAD_REQUEST_PATTERNS = [
  "reason required",
  "actor required",
  "slug is reserved",
  "name required",
  "rank must be",
  "clone source",
  "cannot be cloned",
  "role not found",
  "cannot be edited",
  "patch must be",
  "cannot be patched",
  "theme must be",
  "name must be",
  "must be a string or null",
  "cannot be archived",
  "role already archived",
  "archived roles cannot be re-ranked",
  "both roles must be ranked",
  "the user role cannot be re-ranked",
  "two different roles required",
  // prices / rates / permissions (0187)
  "has no price tier",
  "changes must be an array",
  "each change must be an object",
  "package_id required",
  "duplicate package_id",
  "price key required",
  "price must be",
  "bad service_key",
  "duplicate service_key",
  "value key required",
  "value must be",
  "capabilities required",
  "invalid capability key",
]

/** Translate a function error into a response. Never echoes DB details for unknown errors. */
export function mapRpcError(error: unknown, memberCount?: number): NextResponse {
  const msg = typeof (error as { message?: unknown })?.message === "string" ? (error as { message: string }).message : ""
  if (msg.includes("role has members")) {
    return conflict(memberCount !== undefined ? `Move its ${memberCount} members first.` : "Move its members first.")
  }
  if (msg.includes("ranks changed, reload")) return conflict("The ladder changed. Reload and try again.")
  if (msg.includes("role is archived")) return badRequest("Unknown role")
  if (msg.includes("is below cost")) return conflict("Some prices are below cost.")
  if (/^package \S+ not found/.test(msg)) return badRequest("unknown package")
  if (msg.includes("is already in use")) return conflict("That rank is already in use.")
  if (msg.includes("slug already in use")) return conflict("That slug is already in use.")
  if (BAD_REQUEST_PATTERNS.some((p) => msg.includes(p)) && !CONFLICT_PATTERNS.some((p) => msg.includes(p))) {
    return badRequest(msg)
  }
  console.error("[ROLES-HUB] rpc failed")
  return serverError()
}

export async function readJson(request: NextRequest): Promise<unknown> {
  try {
    return await request.json()
  } catch {
    return undefined
  }
}
