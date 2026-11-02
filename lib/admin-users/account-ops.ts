// Server-side: the per-user account changes shared by the single-user routes and the bulk route.
//   changeUserRole    POST /api/admin/users/update-role  and  POST /api/admin/users/bulk {action: "set_role"}
//   setUserSuspended  POST /api/admin/users/suspend      and  POST /api/admin/users/bulk {action: "suspend" | "unsuspend"}
// One definition of each rule (sub-agents cannot become dealers, the dealer margin adjustment, the auth ban,
// the user's notifications, the audit row), so the bulk path cannot drift from the single-user one.
import type { SupabaseClient } from "@supabase/supabase-js"
import { sendPushToUser } from "@/lib/push-service"
import { writeAudit } from "./route-utils"
import { SUSPEND_REASON_MAX } from "./bulk-params"

export const ASSIGNABLE_ROLES = ["user", "admin", "sub_agent", "dealer"] as const
export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number]

export type OpFailure = { ok: false; status: number; error: string }

export type RoleChangeResult =
  | { ok: true; changed: boolean; oldRole: string; newRole: AssignableRole; audited: boolean }
  | OpFailure

const ROLE_LABELS: Record<string, string> = { dealer: "Dealer", sub_agent: "Sub-agent", admin: "Admin", user: "Standard user" }

/**
 * Set a user's role (public.users.role, the source of truth, and auth user_metadata.role for the session).
 * - A user whose shop has a parent shop (a sub-agent's shop) cannot become a dealer.
 * - Becoming a dealer raises the user's shop_packages margins by (role price - dealer price) so their selling
 *   prices stay the same.
 * - Setting the role a user already has changes nothing (no write, no margin change, no push, no audit row);
 *   before, the margins were raised again each time.
 * - With an adminId, one admin_audit_log row 'user_role_change' {role} -> {role} (best-effort, `audited`).
 *   The CRON bypass (no admin id) is not audited: admin_audit_log.admin_id is NOT NULL.
 * - The user gets a push notification (fire and forget).
 */
export async function changeUserRole(
  db: SupabaseClient,
  opts: { userId: string; role: AssignableRole; adminId?: string | null },
): Promise<RoleChangeResult> {
  const { userId, role, adminId } = opts

  const { data: current, error: readError } = await db.from("users").select("role").eq("id", userId).maybeSingle()
  if (readError) {
    console.error("[UPDATE-ROLE] read failed:", readError.message)
    return { ok: false, status: 500, error: "Failed to update user role" }
  }
  if (!current) return { ok: false, status: 404, error: "User not found" }
  const oldRole = ((current as { role: string | null }).role || "user") as string
  if (oldRole === role) return { ok: true, changed: false, oldRole, newRole: role, audited: false }

  const { data: targetShop } = await db.from("user_shops").select("id, parent_shop_id").eq("user_id", userId).maybeSingle()
  const shop = targetShop as { id: string; parent_shop_id: string | null } | null

  if (role === "dealer" && shop?.parent_shop_id) {
    return {
      ok: false,
      status: 400,
      error: "Sub-agents cannot be upgraded to Dealers. They must be independent users (not linked to a parent shop).",
    }
  }

  const { error: updateError } = await db.from("users").update({ role }).eq("id", userId)
  if (updateError) {
    console.error("[UPDATE-ROLE] Error updating user role:", updateError)
    return { ok: false, status: 500, error: "Failed to update user role" }
  }

  if (role === "dealer" && shop) await adjustDealerMargins(db, userId, shop.id)

  // Also update user_metadata in auth (for session data). Non-blocking: the users table is the source of truth.
  const { error: metaError } = await db.auth.admin.updateUserById(userId, { user_metadata: { role } })
  if (metaError) console.warn("[UPDATE-ROLE] Could not update auth metadata:", metaError.message)

  const audited = adminId
    ? await writeAudit(db, { admin_id: adminId, action: "user_role_change", target_user_id: userId, old_value: { role: oldRole }, new_value: { role } })
    : false

  console.log(`[UPDATE-ROLE] User ${userId} role updated: ${oldRole} -> ${role}`)
  sendPushToUser(userId, {
    title: "🎉 Account Upgraded",
    body: `Your account role has been updated to ${ROLE_LABELS[role] || role}. Refresh the app to see your new access.`,
    data: { url: "/dashboard" },
  }).catch(() => {})

  return { ok: true, changed: true, oldRole, newRole: role, audited }
}

/** Raise each shop_packages margin by (role price - dealer price), so a new dealer's selling prices stay the same. */
async function adjustDealerMargins(db: SupabaseClient, userId: string, shopId: string) {
  console.log(`[UPDATE-ROLE] Upgrading user ${userId} to dealer. Adjusting margins...`)
  const { data: shopPackages, error: pkgError } = await db.from("shop_packages").select("id, package_id, profit_margin").eq("shop_id", shopId)
  if (pkgError || !shopPackages || shopPackages.length === 0) return

  const packageIds = shopPackages.map((sp: any) => sp.package_id)
  const { data: packages, error: priceError } = await db.from("packages").select("id, price, dealer_price").in("id", packageIds)
  if (priceError || !packages) return

  const priceMap = new Map<string, { adminPrice: number; dealerPrice: number | null }>()
  packages.forEach((pkg: any) => priceMap.set(pkg.id, { adminPrice: pkg.price, dealerPrice: pkg.dealer_price }))

  for (const shopPkg of shopPackages as any[]) {
    const prices = priceMap.get(shopPkg.package_id)
    if (prices && prices.dealerPrice !== null && prices.dealerPrice < prices.adminPrice) {
      const newMargin = (shopPkg.profit_margin || 0) + (prices.adminPrice - prices.dealerPrice)
      await db.from("shop_packages").update({ profit_margin: newMargin }).eq("id", shopPkg.id)
      console.log(`[UPDATE-ROLE] Adjusted package ${shopPkg.package_id}: margin ${shopPkg.profit_margin} -> ${newMargin}`)
    }
  }
}

export interface SuspendNotifications {
  sms: boolean
  email: boolean
  sms_error: string | null
  email_error: string | null
}

export type SuspendResult =
  | { ok: true; changed: boolean; audited: boolean; notifications: SuspendNotifications }
  | OpFailure

/**
 * Suspend (auth ban for 100 years + users.is_suspended) or unsuspend a user, audit it, and tell them by SMS,
 * email and push. With `skipUnchanged` (the bulk route), a user already in the requested state is left alone:
 * no write, no audit row, no messages. The single-user route keeps re-applying (it is also the way to resend
 * the notice).
 */
export async function setUserSuspended(
  db: SupabaseClient,
  opts: { userId: string; suspend: boolean; reason?: string | null; adminId?: string | null; skipUnchanged?: boolean },
): Promise<SuspendResult> {
  const { userId, suspend: isSuspending, adminId } = opts
  const reason = typeof opts.reason === "string" && opts.reason.trim() ? opts.reason.trim().slice(0, SUSPEND_REASON_MAX) : null
  const notifications: SuspendNotifications = { sms: false, email: false, sms_error: null, email_error: null }

  const { data: userData, error: userError } = await db
    .from("users")
    .select("email, phone_number, first_name, is_suspended")
    .eq("id", userId)
    .single()
  if (userError || !userData) {
    console.error("[ADMIN-SUSPEND-USER] Failed to fetch user data:", userError)
    return { ok: false, status: 404, error: "User not found in profile table" }
  }
  const user = userData as { email: string | null; phone_number: string | null; first_name: string | null; is_suspended?: boolean | null }
  const wasSuspended = !!user.is_suspended
  if (opts.skipUnchanged && wasSuspended === isSuspending) return { ok: true, changed: false, audited: false, notifications }

  // Auth ban / unban. null clears banned_until.
  const { error: authError } = await db.auth.admin.updateUserById(userId, { ban_duration: isSuspending ? "876000h" : null } as any)
  if (authError) {
    console.error("[ADMIN-SUSPEND-USER] Auth update error:", authError)
    return { ok: false, status: 400, error: `Supabase Auth update failed: ${authError.message}` }
  }

  const { error: dbError } = await db.from("users").update({ is_suspended: isSuspending, updated_at: new Date().toISOString() }).eq("id", userId)
  if (dbError) {
    console.error("[ADMIN-SUSPEND-USER] Database update error:", dbError)
    return { ok: false, status: 500, error: `Auth updated, but database flag failed: ${dbError.message}` }
  }

  // Audit trail with the reason (the user drawer shows the latest suspension's reason). Best-effort.
  const audited = adminId
    ? await writeAudit(db, {
        admin_id: adminId,
        action: isSuspending ? "user_suspend" : "user_unsuspend",
        target_user_id: userId,
        old_value: { is_suspended: wasSuspended },
        new_value: { is_suspended: isSuspending, reason },
      })
    : false

  try {
    if (user.phone_number) {
      const { sendSMS, SMSTemplates } = await import("@/lib/sms-service")
      const smsRes = await sendSMS({
        phone: user.phone_number,
        message: isSuspending ? SMSTemplates.userSuspended(reason ?? undefined) : SMSTemplates.userUnsuspended(),
        type: isSuspending ? "user_suspension" : "user_restoration",
        userId,
      })
      notifications.sms = smsRes.success
      if (!smsRes.success) notifications.sms_error = smsRes.error || "Unknown SMS error"
    }
    if (user.email) {
      const { sendEmail, EmailTemplates } = await import("@/lib/email-service")
      const payload = isSuspending ? EmailTemplates.userSuspended(user.email, reason ?? undefined) : EmailTemplates.userUnsuspended(user.email)
      const emailRes = await sendEmail({
        to: [{ email: user.email, name: user.first_name || "User" }],
        subject: payload.subject,
        htmlContent: payload.html,
        type: isSuspending ? "user_suspension" : "user_restoration",
        userId,
      })
      notifications.email = emailRes.success
      if (!emailRes.success) notifications.email_error = emailRes.error || "Unknown Email error"
    }
    // Push reaches the device regardless of the auth ban.
    sendPushToUser(userId, {
      title: isSuspending ? "⚠️ Account Suspended" : "✅ Account Restored",
      body: isSuspending
        ? `Your account has been suspended${reason ? ": " + reason : ""}. Contact support to appeal.`
        : "Your account has been restored. You can now log in again.",
      data: { url: "/" },
    }).catch(() => {})
  } catch (notifErr: any) {
    console.warn("[ADMIN-SUSPEND-USER] Notification error (non-fatal):", notifErr)
    notifications.sms_error = notifErr?.message ?? String(notifErr)
  }

  return { ok: true, changed: true, audited, notifications }
}
