// Server-side: the per-user account changes shared by the single-user routes and the bulk route.
//   changeUserRole    POST /api/admin/users/update-role  and  POST /api/admin/users/bulk {action: "set_role"}
//   setUserSuspended  POST /api/admin/users/suspend      and  POST /api/admin/users/bulk {action: "suspend" | "unsuspend"}
// One definition of each rule (sub-agents cannot become dealers, the dealer margin adjustment, the auth ban,
// the user's notifications, the audit row), so the bulk path cannot drift from the single-user one.
import type { SupabaseClient } from "@supabase/supabase-js"
import { sendPushToUser } from "@/lib/push-service"
import { sendSMS, SMSTemplates } from "@/lib/sms-service"
import { sendEmail, EmailTemplates } from "@/lib/email-service"
import { writeAudit } from "./route-utils"
import { SUSPEND_REASON_MAX } from "./bulk-params"
import { loadRoles, rolePricesFor, RoleReadError } from "@/lib/roles/repo"
import { CUSTOM_ROLE_ASSIGNMENT_ENABLED } from "@/lib/roles/flags"
import { marginStrategy, recomputeMargin } from "@/lib/roles/margin-strategy"

export const SYSTEM_ROLES = ["user", "admin", "sub_agent", "dealer"] as const
/** Alias kept for the bulk parser, which still only accepts the system roles this phase. */
export const ASSIGNABLE_ROLES = SYSTEM_ROLES
export type AssignableRole = (typeof SYSTEM_ROLES)[number]

const ADMIN_PROTECTED = "Admin accounts can't be moved here."

const isSystemRole = (slug: string) => (SYSTEM_ROLES as readonly string[]).includes(slug)
const isCustomRole = (slug: string) => !isSystemRole(slug)

export type OpFailure = { ok: false; status: number; error: string }

export type RoleChangeResult =
  | { ok: true; changed: boolean; oldRole: string; newRole: string; audited: boolean; note?: string }
  | OpFailure

const ROLE_LABELS: Record<string, string> = { dealer: "Dealer", sub_agent: "Sub-agent", admin: "Admin", user: "Standard user" }

/** One shop_packages margin change made by a role change, recorded in its audit row. */
export interface MarginAdjustment {
  shop_package_id: string
  delta: number
}

const round2 = (n: number) => Math.round(n * 100) / 100

export const MARGINS_NOT_REVERSED_NOTE =
  "Margins were not reversed: this dealer was upgraded before margin changes were recorded. Check their shop prices."

/**
 * Set a user's role (public.users.role, the source of truth, and auth user_metadata.role for the session).
 * - A user whose shop has a parent shop (a sub-agent's shop) cannot become a dealer. If the shop cannot be read,
 *   the change is refused rather than risk making a sub-agent a dealer.
 * - Becoming a dealer raises each shop_packages margin by (role price - dealer price), for packages with a dealer
 *   price above 0 and below the role price, so the shop's selling prices stay the same. The exact deltas are
 *   recorded in the audit row (new_value.margin_adjustments).
 * - Going from dealer back to user (or sub-agent) subtracts exactly the deltas recorded by the latest upgrade, not
 *   deltas recomputed from today's prices (package prices may have changed since), never below a margin of 0.
 *   If that upgrade was not recorded (every dealer made before this change, or through the unaudited CRON
 *   bypass) and the shop has margins it would have raised, the downgrade still goes ahead with the margins left
 *   as they are (the old behaviour), and the result carries MARGINS_NOT_REVERSED_NOTE for the admin: an exact
 *   reversal is not possible, and refusing would block downgrading every existing dealer. dealer -> admin keeps the
 *   margins, as before (callers differ on whether admins are priced as dealers).
 * - Custom roles (anything not in SYSTEM_ROLES): the target must exist and not be archived (else 400 "Unknown role"),
 *   and a sub-agent's shop cannot take one. Margins are then recomputed (lib/roles/margin-strategy.ts) so the
 *   shop's selling price stays fixed: margin += oldBase - newBase, never below 0; recorded as margin_mode
 *   "recompute". A later dealer -> user after a recompute entry recomputes too, not the legacy reversal. All reads
 *   happen before the role write; a read failure refuses the change. System -> system changes never read roles.
 * - The role write is conditional (only if the stored role is still different), so of two concurrent identical
 *   changes only one adjusts margins; the other reports changed: false.
 * - Setting the role a user already has changes nothing (no write, no margin change, no push, no audit row).
 * - With an adminId, one admin_audit_log row 'user_role_change' (best-effort, `audited`). The CRON bypass (no admin
 *   id) is not audited.
 * - The user gets a push notification (fire and forget).
 */
export async function changeUserRole(
  db: SupabaseClient,
  opts: { userId: string; role: string; adminId?: string | null; reason?: string; protectAdmin?: boolean },
): Promise<RoleChangeResult> {
  const { userId, role, adminId } = opts

  // Gate: no live reader prices a custom role yet (see lib/roles/flags.ts). Refused before any DB access.
  // Moving OFF a custom role to a system role stays allowed (the only way back).
  if (isCustomRole(role) && !CUSTOM_ROLE_ASSIGNMENT_ENABLED) {
    return { ok: false, status: 409, error: "Custom roles can't be assigned yet." }
  }

  const { data: current, error: readError } = await db.from("users").select("role").eq("id", userId).maybeSingle()
  if (readError) {
    console.error("[UPDATE-ROLE] read failed:", readError.message)
    return { ok: false, status: 500, error: "Failed to update user role" }
  }
  if (!current) return { ok: false, status: 404, error: "User not found" }
  const oldRole = ((current as { role: string | null }).role || "user") as string
  if (opts.protectAdmin && oldRole === "admin") return { ok: false, status: 403, error: ADMIN_PROTECTED }
  if (oldRole === role) return { ok: true, changed: false, oldRole, newRole: role, audited: false }

  // Custom roles: validate the target (exists, not archived). System -> system changes never read roles.
  if (isCustomRole(role) || isCustomRole(oldRole)) {
    let roles
    try {
      roles = await loadRoles(db)
    } catch (e) {
      if (!(e instanceof RoleReadError)) throw e
      return { ok: false, status: 500, error: "Couldn't load roles, so the role was not changed. Try again." }
    }
    if (isCustomRole(role) && !roles.some((r) => r.slug === role && !r.archived_at)) {
      return { ok: false, status: 400, error: "Unknown role" }
    }
  }

  const leavingDealer = oldRole === "dealer" && role !== "admin"
  const { data: targetShop, error: shopError } = await db.from("user_shops").select("id, parent_shop_id").eq("user_id", userId).maybeSingle()
  if (shopError && (role === "dealer" || leavingDealer || isCustomRole(role) || isCustomRole(oldRole))) {
    console.error("[UPDATE-ROLE] shop read failed:", shopError.message)
    return { ok: false, status: 500, error: "Couldn't verify the user's shop, so the role was not changed. Try again." }
  }
  const shop = (shopError ? null : targetShop) as { id: string; parent_shop_id: string | null } | null

  if (role === "dealer" && shop?.parent_shop_id) {
    return {
      ok: false,
      status: 400,
      error: "Sub-agents cannot be upgraded to Dealers. They must be independent users (not linked to a parent shop).",
    }
  }
  if (isCustomRole(role) && shop?.parent_shop_id) {
    return {
      ok: false,
      status: 400,
      error: "Sub-agents cannot be upgraded to this role. They must be independent users (not linked to a parent shop).",
    }
  }

  // Leaving dealer: read the latest role change (it holds the recorded upgrade and the margin mode).
  let latestPlan: { adjustments: MarginAdjustment[] | null; recompute: boolean } | null = null
  if (leavingDealer && shop) {
    const plan = await recordedUpgrade(db, userId)
    if (!plan.ok) return { ok: false, status: 500, error: "Couldn't read the user's role history, so the role was not changed. Try again." }
    latestPlan = plan
  }
  const strategy = marginStrategy(oldRole, role, { isCustom: isCustomRole, latestRecompute: latestPlan?.recompute ?? false })

  // Work out every margin change before changing anything.
  let reversal: MarginAdjustment[] | null = null
  let notReversed = false
  let recomputePlan: RecomputePlan | null = null
  if (strategy === "legacy" && leavingDealer && shop && latestPlan) {
    if (latestPlan.adjustments) reversal = latestPlan.adjustments
    else notReversed = (await dealerUpgradeDeltas(db, shop.id)).length > 0
  } else if (strategy === "recompute" && shop) {
    const planned = await planRecompute(db, shop.id, oldRole, role)
    if (!planned.ok) return { ok: false, status: 500, error: planned.error }
    recomputePlan = planned
  }

  // Conditional write: only if the stored role is still different (NULL counts as different).
  // protectAdmin: also never overwrite an admin, even one promoted after the read above. One or() so NULL-role
  // users still match (a separate neq("role","admin") would exclude them: NULL <> 'admin' is NULL in SQL).
  const { data: updated, error: updateError } = await db
    .from("users")
    .update({ role })
    .eq("id", userId)
    .or(opts.protectAdmin ? `role.is.null,role.not.in.(admin,${role})` : `role.is.null,role.neq.${role}`)
    .select("id")
  if (updateError) {
    // 0187 trigger: the role was archived after our read.
    if (String(updateError.message ?? "").includes("role is archived")) return { ok: false, status: 400, error: "Unknown role" }
    console.error("[UPDATE-ROLE] Error updating user role:", updateError)
    return { ok: false, status: 500, error: "Failed to update user role" }
  }
  if (!Array.isArray(updated) || updated.length === 0) {
    if (opts.protectAdmin) {
      // 0 rows may mean the user became admin since our read: look again before calling it a no-op.
      const { data: again, error: againError } = await db.from("users").select("role").eq("id", userId).maybeSingle()
      if (againError) return { ok: false, status: 500, error: "Failed to update user role" }
      if (!again) return { ok: false, status: 404, error: "User not found" }
      if ((again as { role: string | null }).role === "admin") return { ok: false, status: 403, error: ADMIN_PROTECTED }
    }
    // Someone else set this role between our read and our write; they did the margin work.
    return { ok: true, changed: false, oldRole, newRole: role, audited: false }
  }

  let margin_adjustments: MarginAdjustment[] | undefined
  if (strategy === "recompute") margin_adjustments = recomputePlan ? await applyRecompute(db, recomputePlan) : []
  else if (role === "dealer") margin_adjustments = shop ? await applyDealerUpgrade(db, userId, shop.id) : []
  else if (reversal) margin_adjustments = await applyReversal(db, reversal)
  const clampNote =
    recomputePlan && recomputePlan.clampedCount > 0
      ? `${recomputePlan.clampedCount} shop packages hit a 0 margin; their selling price rose. Check the shop's prices.`
      : undefined

  // Also update user_metadata in auth (for session data). Non-blocking: the users table is the source of truth.
  const { error: metaError } = await db.auth.admin.updateUserById(userId, { user_metadata: { role } })
  if (metaError) console.warn("[UPDATE-ROLE] Could not update auth metadata:", metaError.message)

  const audited = adminId
    ? await writeAudit(db, {
        admin_id: adminId, action: "user_role_change", target_user_id: userId,
        old_value: { role: oldRole },
        new_value: {
          ...(strategy === "recompute"
            ? { role, margin_mode: "recompute", margin_adjustments: margin_adjustments ?? [] }
            : margin_adjustments ? { role, margin_adjustments } : notReversed ? { role, margins_not_reversed: true } : { role }),
          ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
        },
      })
    : false

  console.log(`[UPDATE-ROLE] User ${userId} role updated: ${oldRole} -> ${role}`)
  const label = ROLE_LABELS[role] || (isCustomRole(role) ? await customRoleName(db, role) : role)
  sendPushToUser(userId, {
    title: "🎉 Account Upgraded",
    body: `Your account role has been updated to ${label}. Refresh the app to see your new access.`,
    data: { url: "/dashboard" },
  }).catch(() => {})

  if (notReversed) return { ok: true, changed: true, oldRole, newRole: role, audited, note: MARGINS_NOT_REVERSED_NOTE }
  return clampNote
    ? { ok: true, changed: true, oldRole, newRole: role, audited, note: clampNote }
    : { ok: true, changed: true, oldRole, newRole: role, audited }
}

/** A custom role's display name for the push (roles.name); the slug when it cannot be read. Never throws. */
async function customRoleName(db: SupabaseClient, slug: string): Promise<string> {
  try {
    const { data } = await db.from("roles").select("name").eq("slug", slug).maybeSingle()
    const name = (data as { name?: unknown } | null)?.name
    return typeof name === "string" && name.trim() ? name : slug
  } catch {
    return slug
  }
}

interface RecomputeWrite { shop_package_id: string; margin: number; next: number }
type RecomputePlan = { ok: true; writes: RecomputeWrite[]; clampedCount: number }

const PACKAGE_ID_CHUNK = 500

/**
 * Selling price stays fixed across a role change: for each package in the shop, margin += oldBase - newBase (clamped
 * at 0), where a base is the role's resolved price (lib/roles). Every read happens here, before the role write.
 */
async function planRecompute(
  db: SupabaseClient,
  shopId: string,
  oldRole: string,
  newRole: string,
): Promise<RecomputePlan | { ok: false; error: string }> {
  const fail = { ok: false as const, error: "Couldn't read the shop's prices, so the role was not changed. Try again." }
  const { data: shopPackages, error: spError } = await db.from("shop_packages").select("id, package_id, profit_margin").eq("shop_id", shopId)
  if (spError || !Array.isArray(shopPackages)) {
    console.error("[UPDATE-ROLE] shop packages read failed:", spError?.message)
    return fail
  }
  if (shopPackages.length === 0) return { ok: true, writes: [], clampedCount: 0 }

  const ids = Array.from(new Set((shopPackages as any[]).map((sp) => String(sp.package_id))))
  const pkgs: Array<{ id: string; price: number; dealer_price: number | null }> = []
  for (let i = 0; i < ids.length; i += PACKAGE_ID_CHUNK) {
    const { data, error } = await db.from("packages").select("id, price, dealer_price").in("id", ids.slice(i, i + PACKAGE_ID_CHUNK))
    if (error || !Array.isArray(data)) {
      console.error("[UPDATE-ROLE] package price read failed:", error?.message)
      return fail
    }
    pkgs.push(...(data as any[]))
  }

  let oldBase: Map<string, number>
  let newBase: Map<string, number>
  try {
    oldBase = await rolePricesFor(db, oldRole, pkgs)
    newBase = await rolePricesFor(db, newRole, pkgs)
  } catch (e) {
    if (!(e instanceof RoleReadError)) throw e
    return fail
  }

  const writes: RecomputeWrite[] = []
  let clampedCount = 0
  for (const sp of shopPackages as any[]) {
    const key = String(sp.package_id)
    const o = oldBase.get(key)
    const n = newBase.get(key)
    if (o === undefined || n === undefined) continue // package not readable: leave its margin alone
    const margin = Number(sp.profit_margin || 0)
    const r = recomputeMargin(margin, o, n)
    if (r.clamped) clampedCount++
    if (r.margin !== margin) writes.push({ shop_package_id: sp.id, margin, next: r.margin })
  }
  return { ok: true, writes, clampedCount }
}

/** Write the planned margins; a failed write is logged (ids only) and left out of the returned record. */
async function applyRecompute(db: SupabaseClient, plan: RecomputePlan): Promise<MarginAdjustment[]> {
  const done: MarginAdjustment[] = []
  for (const w of plan.writes) {
    const { error } = await db.from("shop_packages").update({ profit_margin: w.next }).eq("id", w.shop_package_id)
    if (error) console.error(`[UPDATE-ROLE] margin recompute ${w.shop_package_id} failed:`, error.message)
    else done.push({ shop_package_id: w.shop_package_id, delta: round2(w.next - w.margin) })
  }
  return done
}

/** The margin deltas recorded by the user's latest role change, when that change made them a dealer. */
async function recordedUpgrade(
  db: SupabaseClient,
  userId: string,
): Promise<{ ok: false } | { ok: true; adjustments: MarginAdjustment[] | null; recompute: boolean }> {
  const { data, error } = await db
    .from("admin_audit_log")
    .select("new_value")
    .eq("target_user_id", userId)
    .eq("action", "user_role_change")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) {
    console.error("[UPDATE-ROLE] role history read failed:", error.message)
    return { ok: false }
  }
  const v = (data as { new_value: { role?: unknown; margin_mode?: unknown; margin_adjustments?: unknown } | null } | null)?.new_value
  const recompute = v?.margin_mode === "recompute"
  if (v?.role !== "dealer" || !Array.isArray(v.margin_adjustments)) return { ok: true, adjustments: null, recompute }
  const adjustments = (v.margin_adjustments as unknown[]).filter(
    (a): a is MarginAdjustment => !!a && typeof (a as any).shop_package_id === "string" && Number.isFinite((a as any).delta),
  )
  return { ok: true, adjustments, recompute }
}

/**
 * What becoming a dealer adds to each margin: role price - dealer price, for packages whose dealer price is above 0
 * (lib/pricing/package-price.ts rolePrice ignores a 0 dealer price) and below the role price.
 */
async function dealerUpgradeDeltas(db: SupabaseClient, shopId: string): Promise<Array<MarginAdjustment & { margin: number }>> {
  const { data: shopPackages, error: pkgError } = await db.from("shop_packages").select("id, package_id, profit_margin").eq("shop_id", shopId)
  if (pkgError || !shopPackages || shopPackages.length === 0) return []
  const packageIds = shopPackages.map((sp: any) => sp.package_id)
  const { data: packages, error: priceError } = await db.from("packages").select("id, price, dealer_price").in("id", packageIds)
  if (priceError || !packages) return []
  const priceMap = new Map<string, { adminPrice: number; dealerPrice: number }>()
  packages.forEach((pkg: any) => priceMap.set(pkg.id, { adminPrice: Number(pkg.price), dealerPrice: Number(pkg.dealer_price ?? 0) }))
  const out: Array<MarginAdjustment & { margin: number }> = []
  for (const sp of shopPackages as any[]) {
    const p = priceMap.get(sp.package_id)
    if (p && p.dealerPrice > 0 && p.dealerPrice < p.adminPrice) {
      out.push({ shop_package_id: sp.id, delta: round2(p.adminPrice - p.dealerPrice), margin: Number(sp.profit_margin || 0) })
    }
  }
  return out
}

/** Raise the margins (selling prices stay the same for a new dealer); returns what was added. */
async function applyDealerUpgrade(db: SupabaseClient, userId: string, shopId: string): Promise<MarginAdjustment[]> {
  console.log(`[UPDATE-ROLE] Upgrading user ${userId} to dealer. Adjusting margins...`)
  const deltas = await dealerUpgradeDeltas(db, shopId)
  const done: MarginAdjustment[] = []
  for (const d of deltas) {
    const { error } = await db.from("shop_packages").update({ profit_margin: round2(d.margin + d.delta) }).eq("id", d.shop_package_id)
    if (error) console.error(`[UPDATE-ROLE] margin update ${d.shop_package_id} failed:`, error.message)
    else done.push({ shop_package_id: d.shop_package_id, delta: d.delta })
  }
  return done
}

/** Subtract the recorded upgrade deltas (never below 0); returns what was actually changed (negative deltas). */
async function applyReversal(db: SupabaseClient, recorded: MarginAdjustment[]): Promise<MarginAdjustment[]> {
  if (recorded.length === 0) return []
  const { data, error } = await db.from("shop_packages").select("id, profit_margin").in("id", recorded.map((r) => r.shop_package_id))
  if (error) {
    console.error("[UPDATE-ROLE] margin read for reversal failed:", error.message)
    return []
  }
  const current = new Map(((data ?? []) as Array<{ id: string; profit_margin: number | null }>).map((r) => [r.id, Number(r.profit_margin || 0)]))
  const done: MarginAdjustment[] = []
  for (const r of recorded) {
    const margin = current.get(r.shop_package_id)
    if (margin === undefined) continue // the package was removed from the shop since
    const next = Math.max(0, round2(margin - r.delta))
    const { error: upErr } = await db.from("shop_packages").update({ profit_margin: next }).eq("id", r.shop_package_id)
    if (upErr) console.error(`[UPDATE-ROLE] margin reversal ${r.shop_package_id} failed:`, upErr.message)
    else done.push({ shop_package_id: r.shop_package_id, delta: round2(next - margin) })
  }
  return done
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
  opts: {
    userId: string
    suspend: boolean
    reason?: string | null
    adminId?: string | null
    skipUnchanged?: boolean
    /**
     * Bulk path: instead of awaiting the user's SMS / email / push, hand the send to this callback (it runs after
     * the response). The result's `notifications` then only says that they were deferred (all false).
     */
    deferNotifications?: (send: () => Promise<void>) => void
  },
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

  const send = async () => {
    if (user.phone_number) {
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
  }

  if (opts.deferNotifications) {
    opts.deferNotifications(() => send().catch((e) => console.warn("[ADMIN-SUSPEND-USER] Deferred notification error:", e?.message ?? e)))
    return { ok: true, changed: true, audited, notifications }
  }
  try {
    await send()
  } catch (notifErr: any) {
    console.warn("[ADMIN-SUSPEND-USER] Notification error (non-fatal):", notifErr)
    notifications.sms_error = notifErr?.message ?? String(notifErr)
  }

  return { ok: true, changed: true, audited, notifications }
}
