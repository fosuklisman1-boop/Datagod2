/**
 * One guard for every Phase 2 admin route. verifyAdminAccess also accepts the CRON_SECRET bearer,
 * which carries no userId. A real admin user is required by default; reads may opt in to the cron
 * bearer with { allowCron: true }. Writes always need a real admin (every write must be attributable).
 */
import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"

export type AdminGuardResult =
  | { ok: true; adminId: string | null }
  | { ok: false; response: NextResponse }

export async function adminGuard(request: NextRequest, opts: { write?: boolean; allowCron?: boolean } = {}): Promise<AdminGuardResult> {
  const auth = await verifyAdminAccess(request)
  // errorResponse can accompany isAdmin:true (admin rate limit → 429), so check both.
  if (!auth.isAdmin || auth.errorResponse) {
    return {
      ok: false,
      response: auth.errorResponse ?? NextResponse.json({ success: false, error: "Admin access required" }, { status: 403 }),
    }
  }
  const adminId = (auth as { userId?: string }).userId ?? null
  if (!adminId && (opts.write || !opts.allowCron)) {
    return { ok: false, response: NextResponse.json({ success: false, error: "Admin user required" }, { status: 403 }) }
  }
  return { ok: true, adminId }
}
