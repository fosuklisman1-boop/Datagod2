/**
 * One guard for every Phase 2 admin route. verifyAdminAccess also accepts the CRON_SECRET bearer,
 * which carries no userId — fine for reads, never for writes (every write must be attributable).
 */
import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"

export type AdminGuardResult =
  | { ok: true; adminId: string | null }
  | { ok: false; response: NextResponse }

export async function adminGuard(request: NextRequest, opts: { write?: boolean } = {}): Promise<AdminGuardResult> {
  const auth = await verifyAdminAccess(request)
  if (!auth.isAdmin) return { ok: false, response: auth.errorResponse! }
  const adminId = (auth as { userId?: string }).userId ?? null
  if (opts.write && !adminId) {
    return { ok: false, response: NextResponse.json({ success: false, error: "Admin user required" }, { status: 403 }) }
  }
  return { ok: true, adminId }
}
