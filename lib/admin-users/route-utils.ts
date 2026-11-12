// Server-side helpers shared by the /api/admin/users/[id]/* routes.
import { createClient, type SupabaseClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { isUuid } from "./drawer-params"

export type AdminGate =
  | { ok: true; adminId: string | undefined; adminEmail: string | undefined }
  | { ok: false; response: NextResponse }

/**
 * verifyAdminAccess, honouring every error it returns (including its rate-limit response, which comes back
 * with isAdmin true). For writes (`write: true`) the CRON_SECRET bypass, which has no userId, is refused:
 * every change is audited under the acting admin's own id.
 */
export async function gateAdmin(req: NextRequest, opts: { write?: boolean } = {}): Promise<AdminGate> {
  const { isAdmin, userId, userEmail, errorResponse } = await verifyAdminAccess(req)
  if (!isAdmin || errorResponse) {
    return { ok: false, response: (errorResponse as NextResponse | undefined) ?? NextResponse.json({ error: "Forbidden" }, { status: 403 }) }
  }
  if (opts.write && !userId) {
    return { ok: false, response: NextResponse.json({ error: "Admin session required" }, { status: 403 }) }
  }
  return { ok: true, adminId: userId, adminEmail: userEmail }
}

export type IdCtx = { params: Promise<{ id: string }> }

/** The [id] route param, or a 400 response when it is not a UUID. */
export async function userIdParam(ctx: IdCtx): Promise<{ ok: true; id: string } | { ok: false; response: NextResponse }> {
  const { id } = await ctx.params
  if (!isUuid(id)) return { ok: false, response: NextResponse.json({ error: "Invalid user id" }, { status: 400 }) }
  return { ok: true, id }
}

export function serviceClient(): SupabaseClient {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

export const badRequest = (error: string) => NextResponse.json({ error }, { status: 400 })

/** Insert one admin_audit_log row. Returns false (and logs) on failure rather than throwing. */
export async function writeAudit(
  db: SupabaseClient,
  row: { admin_id: string; action: string; target_user_id: string; old_value?: unknown; new_value?: unknown },
): Promise<boolean> {
  const { error } = await db.from("admin_audit_log").insert([{ ...row, old_value: row.old_value ?? null, new_value: row.new_value ?? null }])
  if (error) {
    console.error(`[ADMIN-AUDIT] ${row.action} insert failed:`, error.message)
    return false
  }
  return true
}
