import { NextRequest, NextResponse } from "next/server"
import { gateAdmin, serviceClient, userIdParam, writeAudit, type IdCtx } from "@/lib/admin-users/route-utils"

export const dynamic = "force-dynamic"

/**
 * POST /api/admin/users/[id]/force-logout
 *
 * Signs the user out of every device. supabase-js's auth.admin.signOut(jwt, scope) needs the USER's access
 * token, which an admin does not have, so this deletes the user's rows from auth.sessions through the
 * existing service-role-only SECURITY DEFINER RPC revoke_other_user_sessions(p_uid, p_keep => NULL)
 * (migrations/0082, the same function behind the profile page's "log out other devices"). Deleting a session
 * cascades to its auth.refresh_tokens rows, so no device can refresh. An access token already issued stays
 * validly signed until it expires (the project's JWT expiry, 1 hour by default), but Supabase Auth rejects it
 * at once (getUser -> session_not_found), so every API route that authenticates with getUser refuses the user
 * immediately. Only direct PostgREST reads under RLS (which check the signature alone) keep working until
 * that token expires, and then the client cannot refresh and is signed out.
 *
 * Audited as 'user_force_logout' with the number of sessions revoked. Refuses the CRON bypass.
 * → { success, sessionsRevoked, audited }
 */
export async function POST(req: NextRequest, ctx: IdCtx) {
  const gate = await gateAdmin(req, { write: true })
  if (!gate.ok) return gate.response
  const idp = await userIdParam(ctx)
  if (!idp.ok) return idp.response
  const adminId = gate.adminId!

  const db = serviceClient()
  const { data: user, error: userErr } = await db.auth.admin.getUserById(idp.id)
  if (userErr || !user?.user) return NextResponse.json({ error: "User not found" }, { status: 404 })

  const { data, error } = await db.rpc("revoke_other_user_sessions", { p_uid: idp.id, p_keep: null })
  if (error) {
    console.error("[ADMIN-FORCE-LOGOUT]", error.message)
    return NextResponse.json({ error: "Failed to sign the user out" }, { status: 500 })
  }
  const sessionsRevoked = Number(data ?? 0)
  const audited = await writeAudit(db, {
    admin_id: adminId,
    action: "user_force_logout",
    target_user_id: idp.id,
    new_value: { sessions_revoked: sessionsRevoked },
  })
  return NextResponse.json({ success: true, sessionsRevoked, audited })
}
