import type { SupabaseClient } from "@supabase/supabase-js"
import { createDraft } from "./repo"
import { CAPS, EXPIRY_MS, type DraftToolResult } from "./types"
import { resolveBulkStatusIds, type BulkStatusFilters } from "./bulk-status-ids"
import { amountError, balanceAfter, reasonError } from "@/lib/admin-users/drawer-params"
import { isUuid } from "@/lib/pricing/custom-prices-input"
import { CUSTOM_ROLE_ASSIGNMENT_ENABLED } from "@/lib/roles/flags"
import { loadRoles } from "@/lib/roles/repo"

// Builders behind the admin AI's prepare_* tools. They re-derive everything from the DB, refuse what cannot be
// drafted and store a pending draft. They execute nothing: the confirm route runs the real endpoint after the
// admin taps Confirm (and re-checks that the caller is an admin). No names, phones or emails go to logs.

export interface PrepareAdminCtx {
  adminId: string
  conversationKey: string | null
  /** Drafts created by background tasks live 12 h instead of 5 min. */
  background?: boolean
}

type Line = { label: string; value: string }

const refuse = (code: string, message: string): DraftToolResult => ({ refused: true, code, message })
const ghs = (n: number) => `GHS ${n.toFixed(2)}`
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100
const expiryFor = (ctx: PrepareAdminCtx) => (ctx.background ? EXPIRY_MS.adminBackground : EXPIRY_MS.admin)
const missingAdmin = () => refuse("admin_required", "A signed-in admin is required to prepare this action.")

// Mirrors the system roles in lib/admin-users/account-ops.ts (kept local so this module stays free of the
// notification stack that file imports).
const SYSTEM_ROLES = ["user", "admin", "sub_agent", "dealer"]

// Statuses each withdrawal route accepts. Source: app/api/admin/withdrawals/{approve,reject,complete}/route.ts
// (approve: pending|failed, reject: rejectableStatuses, complete: approved).
const WITHDRAWAL_ELIGIBLE: Record<"approve" | "reject" | "complete", readonly string[]> = {
  approve: ["pending", "failed"],
  reject: ["pending", "failed", "approved", "awaiting_transfer_otp"],
  complete: ["approved"],
}

// Mirrors ALLOWED_STATUSES in app/api/admin/orders/bulk-update-status/route.ts.
const BULK_ALLOWED_STATUSES = ["pending", "processing", "completed", "failed", "cancelled", "blacklisted", "refunded", "rejected"]

/** Drafts for the five admin actions. */

// ---------------------------------------------------------------------------------------------------------------------
// Wallet adjustment
// ---------------------------------------------------------------------------------------------------------------------

export async function prepareWalletAdjustment(
  db: SupabaseClient,
  ctx: PrepareAdminCtx,
  input: { user_id: string; type: string; amount: number; reason: string },
): Promise<DraftToolResult> {
  if (!ctx.adminId) return missingAdmin()
  if (!isUuid(input.user_id)) return refuse("user_not_found", "That user id is not valid.")
  if (input.user_id === ctx.adminId) {
    return refuse("self_not_allowed", "An admin cannot adjust their own wallet. Ask another admin.")
  }
  if (input.type !== "credit" && input.type !== "debit") {
    return refuse("invalid_amount", "The adjustment type must be credit or debit.")
  }
  const aErr = amountError(input.amount)
  if (aErr) return refuse("invalid_amount", aErr)
  if (input.amount > CAPS.walletAdjustmentGhs) {
    return refuse("over_cap", `Adjustments above ${ghs(CAPS.walletAdjustmentGhs)} cannot be made through chat. Use the admin users page.`)
  }
  const rErr = reasonError(input.reason)
  if (rErr) return refuse("reason_required", rErr)

  const { data: user, error: userErr } = await db.from("users").select("id").eq("id", input.user_id).maybeSingle()
  if (userErr || !user) return refuse("user_not_found", "No user was found with that id.")

  const { data: wallet } = await db.from("wallets").select("balance").eq("user_id", input.user_id).maybeSingle()
  if (!wallet) return refuse("user_not_found", "This user has no wallet.")
  const balanceBefore = Number((wallet as any).balance)
  if (!Number.isFinite(balanceBefore)) return refuse("user_not_found", "This user's wallet balance could not be read.")

  const type = input.type as "credit" | "debit"
  const after = balanceAfter(balanceBefore, type, input.amount)
  if (after < 0) return refuse("insufficient_balance", `A debit of ${ghs(input.amount)} would take the wallet below 0 (balance ${ghs(balanceBefore)}).`)

  const reason = input.reason.trim()
  const display: Record<string, unknown> = {
    title: type === "credit" ? "Confirm wallet credit" : "Confirm wallet debit",
    lines: [
      { label: "Type", value: type === "credit" ? "Credit" : "Debit" },
      { label: "Amount", value: ghs(input.amount) },
      { label: "Balance", value: `${ghs(balanceBefore)} → ${ghs(after)}` },
      { label: "Reason", value: reason },
    ] as Line[],
    amountGhs: input.amount,
    balanceBefore,
    balanceAfter: after,
  }

  const draft = await createDraft(db, {
    userId: ctx.adminId,
    context: "admin",
    action: "wallet_adjustment",
    params: { targetUserId: input.user_id, type, amount: input.amount, reason, balanceBefore },
    display,
    amountGhs: input.amount,
    conversationKey: ctx.conversationKey,
    expiresInMs: expiryFor(ctx),
  })
  return { draft_id: draft.id, display, expires_at: draft.expires_at, warnings: [] }
}

// ---------------------------------------------------------------------------------------------------------------------
// Withdrawals (single or bulk)
// ---------------------------------------------------------------------------------------------------------------------

export async function prepareWithdrawalAction(
  db: SupabaseClient,
  ctx: PrepareAdminCtx,
  input: { action: string; withdrawal_ids: string[]; reason?: string },
): Promise<DraftToolResult> {
  if (!ctx.adminId) return missingAdmin()
  const action = input.action as "approve" | "reject" | "complete"
  if (!(action in WITHDRAWAL_ELIGIBLE)) return refuse("invalid_action", "The action must be approve, reject or complete.")

  const ids = Array.isArray(input.withdrawal_ids) ? [...new Set(input.withdrawal_ids)] : []
  if (ids.length === 0 || !ids.every((i) => typeof i === "string" && isUuid(i))) {
    return refuse("invalid_withdrawal_state", "Provide the withdrawal ids to act on.")
  }

  let reason: string | undefined
  if (action === "reject") {
    const rErr = reasonError(input.reason)
    if (rErr) return refuse("reason_required", "Rejecting a withdrawal needs a reason of 5 to 500 characters.")
    reason = (input.reason as string).trim()
  }

  const { data: rows, error } = await db.from("withdrawal_requests").select("id, shop_id, amount, status").in("id", ids)
  if (error) return refuse("invalid_withdrawal_state", "The withdrawals could not be read. Try again shortly.")
  const found = (rows ?? []) as { id: string; shop_id: string | null; amount: number | string; status: string }[]
  const eligible = found.filter((w) => WITHDRAWAL_ELIGIBLE[action].includes(w.status))
  if (found.length !== ids.length || eligible.length !== ids.length) {
    const bad = ids.length - eligible.length
    return refuse(
      "invalid_withdrawal_state",
      `${bad} of ${ids.length} withdrawal${ids.length === 1 ? " is" : "s are"} missing or not in a state that can be ${action === "complete" ? "completed" : action + "d"}.`,
    )
  }

  const total = round2(eligible.reduce((s, w) => s + Number(w.amount), 0))
  if (!Number.isFinite(total) || total <= 0) return refuse("invalid_withdrawal_state", "The withdrawal amounts could not be read.")
  if (total > CAPS.withdrawalTotalGhs) {
    return refuse("over_cap", `A batch of ${ghs(total)} is above the ${ghs(CAPS.withdrawalTotalGhs)} limit for chat. Split it or use the withdrawals page.`)
  }

  // Requester names: the shop that asked for each withdrawal (as the approve route's notifier reads it).
  const shopIds = [...new Set(eligible.map((w) => w.shop_id).filter((s): s is string => !!s))]
  const names = new Map<string, string>()
  if (shopIds.length > 0) {
    const { data: shops } = await db.from("user_shops").select("id, shop_name").in("id", shopIds)
    for (const s of (shops ?? []) as { id: string; shop_name: string | null }[]) names.set(s.id, s.shop_name ?? "Unnamed shop")
  }
  const requesters = eligible.slice(0, 5).map((w) => `${(w.shop_id && names.get(w.shop_id)) || "Unknown shop"} (${ghs(Number(w.amount))})`)

  const verb = action === "approve" ? "Approve" : action === "reject" ? "Reject" : "Complete"
  const lines: Line[] = [
    { label: "Action", value: verb },
    { label: "Withdrawals", value: String(eligible.length) },
    { label: "Total", value: ghs(total) },
    { label: "Requesters", value: requesters.join(", ") + (eligible.length > 5 ? `, and ${eligible.length - 5} more` : "") },
  ]
  if (reason) lines.push({ label: "Reason", value: reason })
  const display: Record<string, unknown> = {
    title: `Confirm ${verb.toLowerCase()} ${eligible.length === 1 ? "withdrawal" : "withdrawals"}`,
    lines,
    count: eligible.length,
    totalGhs: total,
    requesters,
  }

  const draft = await createDraft(db, {
    userId: ctx.adminId,
    context: "admin",
    action: "withdrawal_action",
    params: { action, ids: eligible.map((w) => w.id), totalGhs: total, ...(reason ? { reason } : {}) },
    display,
    amountGhs: total,
    conversationKey: ctx.conversationKey,
    expiresInMs: expiryFor(ctx),
  })
  return { draft_id: draft.id, display, expires_at: draft.expires_at, warnings: [] }
}

// ---------------------------------------------------------------------------------------------------------------------
// Suspension
// ---------------------------------------------------------------------------------------------------------------------

export async function prepareUserSuspension(
  db: SupabaseClient,
  ctx: PrepareAdminCtx,
  input: { user_id: string; suspend: boolean },
): Promise<DraftToolResult> {
  if (!ctx.adminId) return missingAdmin()
  if (!isUuid(input.user_id)) return refuse("user_not_found", "That user id is not valid.")
  if (input.user_id === ctx.adminId) return refuse("self_not_allowed", "An admin cannot suspend or unsuspend their own account.")
  if (typeof input.suspend !== "boolean") return refuse("no_change", "Say whether to suspend or unsuspend.")

  // The suspend route reads users.is_suspended.
  const { data: user, error } = await db.from("users").select("id, is_suspended").eq("id", input.user_id).maybeSingle()
  if (error || !user) return refuse("user_not_found", "No user was found with that id.")
  const wasSuspended = !!(user as any).is_suspended
  if (wasSuspended === input.suspend) {
    return refuse("no_change", input.suspend ? "This user is already suspended." : "This user is not suspended.")
  }

  const display: Record<string, unknown> = {
    title: input.suspend ? "Confirm suspension" : "Confirm unsuspension",
    lines: [
      { label: "Action", value: input.suspend ? "Suspend" : "Unsuspend" },
      { label: "Now", value: wasSuspended ? "Suspended" : "Active" },
      { label: "After", value: input.suspend ? "Suspended (cannot sign in)" : "Active" },
    ] as Line[],
  }
  const draft = await createDraft(db, {
    userId: ctx.adminId,
    context: "admin",
    action: "user_suspension",
    params: { targetUserId: input.user_id, suspend: input.suspend },
    display,
    amountGhs: null,
    conversationKey: ctx.conversationKey,
    expiresInMs: expiryFor(ctx),
  })
  return { draft_id: draft.id, display, expires_at: draft.expires_at, warnings: [] }
}

// ---------------------------------------------------------------------------------------------------------------------
// Role change
// ---------------------------------------------------------------------------------------------------------------------

export async function prepareRoleChange(
  db: SupabaseClient,
  ctx: PrepareAdminCtx,
  input: { user_id: string; role: string },
): Promise<DraftToolResult> {
  if (!ctx.adminId) return missingAdmin()
  if (!isUuid(input.user_id)) return refuse("user_not_found", "That user id is not valid.")
  if (input.user_id === ctx.adminId) return refuse("self_not_allowed", "An admin cannot change their own role.")
  const role = input.role
  if (typeof role !== "string" || !role) return refuse("invalid_role", "A role is required.")

  // Same validation as changeUserRole (lib/admin-users/account-ops.ts): a system role, or a custom role that is
  // assignable (flag on), exists and is not archived.
  const isCustom = !SYSTEM_ROLES.includes(role)
  if (isCustom) {
    if (!CUSTOM_ROLE_ASSIGNMENT_ENABLED) return refuse("invalid_role", "Custom roles can't be assigned yet.")
    let known = false
    try {
      known = (await loadRoles(db as any)).some((r) => r.slug === role && !r.archived_at)
    } catch {
      return refuse("invalid_role", "Roles could not be loaded, so the role cannot be checked. Try again shortly.")
    }
    if (!known) return refuse("invalid_role", "Unknown role.")
  }

  const { data: user, error } = await db.from("users").select("id, role").eq("id", input.user_id).maybeSingle()
  if (error || !user) return refuse("user_not_found", "No user was found with that id.")
  const fromRole = String((user as any).role || "user")
  if (fromRole === role) return refuse("no_change", `This user already has the role '${role}'.`)

  if (fromRole === "admin") {
    const { data: admins } = await db.from("users").select("id").eq("role", "admin")
    if (((admins ?? []) as unknown[]).length <= 1) return refuse("last_admin", "This is the only admin, so their role cannot be changed.")
  }

  if (role === "dealer" || isCustom) {
    const { data: shop } = await db.from("user_shops").select("id, parent_shop_id").eq("user_id", input.user_id).maybeSingle()
    if ((shop as any)?.parent_shop_id) {
      return refuse("invalid_role", "Sub-agents cannot be given this role. They must be independent users (not linked to a parent shop).")
    }
  }

  const display: Record<string, unknown> = {
    title: "Confirm role change",
    lines: [
      { label: "Role", value: `${fromRole} → ${role}` },
      ...(role === "dealer" ? [{ label: "Note", value: "Shop margins are adjusted so selling prices stay the same." }] : []),
    ] as Line[],
    fromRole,
    toRole: role,
  }
  const draft = await createDraft(db, {
    userId: ctx.adminId,
    context: "admin",
    action: "role_change",
    params: { targetUserId: input.user_id, fromRole, toRole: role },
    display,
    amountGhs: null,
    conversationKey: ctx.conversationKey,
    expiresInMs: expiryFor(ctx),
  })
  return { draft_id: draft.id, display, expires_at: draft.expires_at, warnings: [] }
}

// ---------------------------------------------------------------------------------------------------------------------
// Bulk order status
// ---------------------------------------------------------------------------------------------------------------------

export async function prepareBulkStatusUpdate(
  db: SupabaseClient,
  ctx: PrepareAdminCtx,
  input: { status: string; filters: BulkStatusFilters },
): Promise<DraftToolResult> {
  if (!ctx.adminId) return missingAdmin()
  const status = input.status
  if (typeof status !== "string" || !BULK_ALLOWED_STATUSES.includes(status)) {
    return refuse("invalid_status", `The status must be one of: ${BULK_ALLOWED_STATUSES.join(", ")}.`)
  }
  const f = input.filters ?? {}
  const filters: BulkStatusFilters = {}
  if (f.filter_status) filters.filter_status = String(f.filter_status)
  if (f.filter_network) filters.filter_network = String(f.filter_network)
  if (f.date_from) filters.date_from = String(f.date_from)
  if (f.date_to) filters.date_to = String(f.date_to)
  if (Object.keys(filters).length === 0) {
    return refuse("filter_required", "At least one filter is required for a bulk update to prevent accidental mass changes.")
  }

  let idsByTable
  try {
    idsByTable = await resolveBulkStatusIds(db, filters, status)
  } catch {
    return refuse("lookup_failed", "The matching orders could not be looked up. Try again shortly.")
  }

  const tables = ["orders", "shop_orders", "ussd_orders", "ussd_shop_orders", "api_orders"] as const
  const total = tables.reduce((n, t) => n + idsByTable[t].length, 0)
  if (total === 0) return refuse("no_matching_orders", "No orders match those filters.")
  if (total > CAPS.bulkStatusIds) {
    return refuse("over_cap", `${total} orders match, which is above the ${CAPS.bulkStatusIds} limit for one bulk update. Narrow the filters.`)
  }

  const counts: Record<string, number> = {}
  for (const t of tables) if (idsByTable[t].length > 0) counts[t] = idsByTable[t].length
  const samples = tables.flatMap((t) => idsByTable[t]).slice(0, 5).map((id) => id.slice(0, 8))
  const display: Record<string, unknown> = {
    title: `Confirm bulk update to "${status}"`,
    lines: [
      { label: "New status", value: status },
      { label: "Orders", value: String(total) },
      ...Object.entries(counts).map(([t, n]) => ({ label: t, value: String(n) })),
      { label: "Samples", value: samples.join(", ") },
    ] as Line[],
    total,
    counts,
    samples,
  }

  const draft = await createDraft(db, {
    userId: ctx.adminId,
    context: "admin",
    action: "bulk_status_update",
    params: { status, idsByTable, filter: filters },
    display,
    amountGhs: null,
    conversationKey: ctx.conversationKey,
    expiresInMs: expiryFor(ctx),
  })
  return { draft_id: draft.id, display, expires_at: draft.expires_at, warnings: [] }
}
