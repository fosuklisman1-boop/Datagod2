import { NextRequest, NextResponse } from "next/server"
import { gateAdmin, serviceClient, userIdParam, writeAudit, type IdCtx } from "@/lib/admin-users/route-utils"

export const dynamic = "force-dynamic"

/**
 * POST /api/admin/users/[id]/force-logout
 *
 * Ends every signed-in session of the user. supabase-js's auth.admin.signOut(jwt, scope) needs the USER's
 * access token, which an admin does not have, so this deletes the user's rows from auth.sessions through the
 * existing service-role-only SECURITY DEFINER RPC revoke_other_user_sessions(p_uid, p_keep => NULL)
 * (migrations/0082, the same function behind the profile page's "log out other devices"). Deleting a session
 * cascades to its auth.refresh_tokens rows, so no device can refresh, and Supabase Auth rejects the session's
 * access tokens at once (getUser -> session_not_found), so API routes that authenticate with getUser refuse them.
 *
 * It is NOT a lockout:
 *   - the user can sign straight back in with their password;
 *   - API keys (api_v2 / user_api_keys) and the WhatsApp bot do not use sessions and keep working;
 *   - an access token already issued stays validly signed until it expires (JWT expiry, 1 hour by default),
 *     so direct PostgREST reads under RLS from a page already open keep working until then.
 * To lock a user out, suspend them (bans the auth user) and send a password reset.
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
