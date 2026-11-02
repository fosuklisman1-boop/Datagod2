import { NextRequest, NextResponse } from "next/server"
import { gateAdmin, serviceClient, userIdParam, type IdCtx } from "@/lib/admin-users/route-utils"

export const dynamic = "force-dynamic"

/**
 * GET /api/admin/users/[id]/profile
 *
 * The Profile tab of the admin user drawer (also how the drawer opens a sub-agent or parent from the
 * Shop tab, where only the id is known): the public.users profile, the auth user's sign-in data, the wallet
 * balance, and the reason given with the latest suspension (from admin_audit_log 'user_suspend'; the
 * suspend route did not record reasons before this change, so older suspensions have none).
 */
export async function GET(req: NextRequest, ctx: IdCtx) {
  const gate = await gateAdmin(req)
  if (!gate.ok) return gate.response
  const idp = await userIdParam(ctx)
  if (!idp.ok) return idp.response
  const id = idp.id

  const db = serviceClient()
  const [profile, auth, wallet, suspension] = await Promise.all([
    db.from("users")
      .select("id, email, phone_number, first_name, last_name, role, is_suspended, pricing_mode, phone_verified, phone_verify_deadline, created_at")
      .eq("id", id).maybeSingle(),
    db.auth.admin.getUserById(id),
    db.from("wallets").select("balance", { count: "exact" }).eq("user_id", id).order("balance", { ascending: false }).limit(1).maybeSingle(),
    db.from("admin_audit_log").select("new_value, created_at")
      .eq("target_user_id", id).eq("action", "user_suspend")
      .order("created_at", { ascending: false }).limit(1).maybeSingle(),
  ])

  if (profile.error) {
    console.error("[ADMIN-USER-PROFILE]", profile.error.message)
    return NextResponse.json({ error: "Failed to load user" }, { status: 500 })
  }
  const authUser = auth.error ? null : auth.data?.user ?? null
  const p = profile.data as Record<string, any> | null
  if (!p && !authUser) return NextResponse.json({ error: "User not found" }, { status: 404 })
  if (wallet.error) console.warn("[ADMIN-USER-PROFILE] wallet:", wallet.error.message)
  if (suspension.error) console.warn("[ADMIN-USER-PROFILE] suspension:", suspension.error.message)

  const isSuspended = !!p?.is_suspended
  const s = suspension.data as { new_value: { reason?: string | null } | null; created_at: string } | null
  return NextResponse.json({
    id,
    email: authUser?.email ?? p?.email ?? "",
    phoneNumber: p?.phone_number ?? "",
    firstName: p?.first_name ?? null,
    lastName: p?.last_name ?? null,
    role: p?.role || "user",
    pricingMode: p?.pricing_mode ?? "role",
    isSuspended,
    suspension: isSuspended && s ? { reason: s.new_value?.reason || null, at: s.created_at } : null,
    phoneVerified: p?.phone_verified === true,
    phoneVerifyDeadline: p?.phone_verify_deadline ?? null,
    createdAt: authUser?.created_at ?? p?.created_at ?? null,
    lastSignInAt: authUser?.last_sign_in_at ?? null,
    emailConfirmedAt: authUser?.email_confirmed_at ?? null,
    hasProfile: !!p,
    walletBalance: Number((wallet.data as { balance: unknown } | null)?.balance ?? 0),
    // More than one wallet row is a data problem: the balance above is the larger, and adjustments are refused.
    walletRows: wallet.count ?? (wallet.data ? 1 : 0),
  })
}
