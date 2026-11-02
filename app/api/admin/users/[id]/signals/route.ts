import { NextRequest, NextResponse } from "next/server"
import { gateAdmin, serviceClient, userIdParam, type IdCtx } from "@/lib/admin-users/route-utils"
import { loadUserSignals } from "@/lib/admin-users/signals-server"

export const dynamic = "force-dynamic"

/**
 * GET /api/admin/users/[id]/signals -> { signals: { lastOrderAt, phoneVerified, phoneBlacklisted, flags } | null }
 * The same signals the users list shows for its page (public.admin_user_signals + lib/blacklist.ts), for the
 * drawer's Profile tab.
 */
export async function GET(req: NextRequest, ctx: IdCtx) {
  const gate = await gateAdmin(req)
  if (!gate.ok) return gate.response
  const idp = await userIdParam(ctx)
  if (!idp.ok) return idp.response
  try {
    const signals = await loadUserSignals(serviceClient(), [{ id: idp.id }])
    return NextResponse.json({ signals: signals.get(idp.id) ?? null })
  } catch (e: any) {
    console.error("[ADMIN-USER-SIGNALS]", e?.message ?? e)
    return NextResponse.json({ error: "Failed to load activity signals" }, { status: 500 })
  }
}
