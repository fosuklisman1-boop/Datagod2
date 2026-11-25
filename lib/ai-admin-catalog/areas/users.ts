import { z } from "zod"
import type { CardCtx, CardLine, CatalogEntry, EntryInput } from "../types"
import { pageTitleFor } from "../pages"
import { maskEmail, maskPhone, userLabel } from "@/lib/ai-drafts/user-label"
import { CUSTOM_ROLE_ASSIGNMENT_ENABLED } from "@/lib/roles/flags"
import { ALL_CAPABILITIES } from "@/lib/roles/capabilities"
import { BADGE_COLORS, HUB_SERVICE_KEYS, ROLE_ICONS } from "@/lib/roles/admin/validate"
import { RESET_MAX_PER_HOUR, RESET_TOKEN_TTL_MINUTES } from "@/lib/password-reset"

// Users group: /api/admin/ users, set-admin, set-admin-by-email, remove-admin, remove-user, change-user-password,
// update-balance, debtors, signup-sources, roles. The most sensitive group: admin rights, roles and rights, passwords,
// balances and account removal. Every change card names the person (name plus a masked phone or email, never the
// full contact detail) and every side effect the handler has: sessions ended, messages sent, audit rows written (or
// not), data deleted.
//
// Typed tools already do three of these exactly (same endpoint, same body): update-balance (prepare_wallet_adjustment),
// users/suspend (prepare_user_suspension) and users/update-role (prepare_role_change).
//
// Passwords: change-user-password takes its new password through the secure box (secretFields), never the schema.
// users/update-user can also set a password in the handler; that key is NOT in the schema here, so a password can
// only be set through change-user-password.
//
// Auth notes: set-admin-by-email does not call verifyAdminAccess; it checks the caller's bearer token and then
// public.users.role = 'admin' itself, which is the same bar, so it is listed as "other". Every roles hub route uses
// requireHubAdmin (verifyAdminAccess plus a real admin id). The custom-role feature switch
// (lib/roles/flags.ts) only blocks ASSIGNING a custom role to a user; the hub routes themselves still run.
//
// Left out on purpose (see EXCLUDED): customers/* (shop-owner routes scoped to the caller's own shop, not admin
// routes), users/bulk (maxDuration 300, up to 200 users, or a message to up to 5000), users/export (up to 5000
// users' contact details in one reply, same data as the list) and initialize-balance (a GET that rebuilds every
// shop's balance from at most the first 1000 profit rows).

const uuid = z.string().uuid()
const reason5 = z.string().min(5).max(500)
const roleReason = z.string().min(3).max(300)
const dateText = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const pageNo = z.number().int().min(1).max(100000)
const drawerPageSize = z.number().int().min(1).max(50)
const roleSlug = z.string().regex(/^[a-z][a-z0-9_]{1,19}$/)

const where = (page: string) => ({ page, pageTitle: pageTitleFor(page) ?? page })

const ghs = (n: unknown) => `GHS ${Number(n).toFixed(2)}`
const short = (id: unknown) => String(id ?? "").slice(0, 8)

type Card = { summary: string; lines: CardLine[] }
type Obj = Record<string, unknown>

async function readRows(run: () => PromiseLike<{ data: unknown; error?: unknown }>): Promise<Obj[] | null> {
  try {
    const { data, error } = await run()
    if (error || !Array.isArray(data)) return null
    return data as Obj[]
  } catch {
    return null
  }
}

async function readRow(run: () => PromiseLike<{ data: unknown; error?: unknown }>): Promise<Obj | null> {
  try {
    const { data, error } = await run()
    if (error || !data || typeof data !== "object" || Array.isArray(data)) return null
    return data as Obj
  } catch {
    return null
  }
}

async function readCount(run: () => PromiseLike<{ count?: number | null; error?: unknown }>): Promise<number | null> {
  try {
    const { count, error } = await run()
    if (error || typeof count !== "number") return null
    return count
  } catch {
    return null
  }
}

const asBody = (i: EntryInput): Obj => (i.body ?? {}) as Obj
const str = (v: unknown): string => (typeof v === "string" ? v : "")
const lc = (v: unknown): string => str(v).trim().toLowerCase()
const listOf = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [])

/** 024 *** 4567 from any phone-looking text; short or empty input gives "***". */
function maskAny(p: unknown): string {
  const digits = String(p ?? "").replace(/\D/g, "")
  const local = digits.startsWith("233") && digits.length === 12 ? `0${digits.slice(3)}` : digits
  return local.length >= 7 ? maskPhone(local) : "***"
}

const USER_COLS = "first_name, last_name, phone_number, email, role"

/** The user row and the "Name · masked contact" label the other cards use. */
async function who(ctx: CardCtx, id: string): Promise<{ row: Obj | null; label: string }> {
  if (!id) return { row: null, label: "(no user id given)" }
  const row = await readRow(() => ctx.db.from("users").select(USER_COLS).eq("id", id).maybeSingle())
  return { row, label: userLabel(id, row as never) }
}

const roleOf = (row: Obj | null): string => str(row?.role) || "user"

async function adminCount(ctx: CardCtx): Promise<number | null> {
  const rows = await readRows(() => ctx.db.from("users").select("id").eq("role", "admin"))
  return rows ? rows.length : null
}

// ---------------------------------------------------------------------------------------------------------------------
// Cards: users and admin rights
// ---------------------------------------------------------------------------------------------------------------------

async function setAdminCard(i: EntryInput, ctx: CardCtx): Promise<Card> {
  const id = str(asBody(i).userId)
  const { row, label } = await who(ctx, id)
  const fullName = [row?.first_name, row?.last_name].map((s) => str(s).trim()).filter(Boolean).join(" ")
  const lines: CardLine[] = [
    { label: "User", value: row ? `${fullName || "(no name)"} · ${row.phone_number ? maskAny(row.phone_number) : "no phone"}` : label },
    { label: "User id", value: id || "(none)" },
  ]
  if (row) {
    lines.push({ label: "Role now", value: roleOf(row) })
    if (roleOf(row) === "admin") lines.push({ label: "Note", value: "This user is already an admin, so nothing changes." })
  } else {
    lines.push({
      label: "Problem",
      value: "(no such user — the route still reports success). Nothing would be granted.",
    })
  }
  lines.push({
    label: "Danger",
    value:
      "Makes this user a full admin: every admin page and action, including wallet adjustments, refunds, withdrawals, passwords and account removal. Their sign-in role is updated to admin too.",
  })
  lines.push({ label: "Record", value: "The grant is written to the admin history (who granted admin to whom). The user is not notified." })
  return { summary: "Grant full admin access to a user", lines }
}

async function removeAdminCard(i: EntryInput, ctx: CardCtx): Promise<Card> {
  const id = str(asBody(i).userId)
  const { row, label } = await who(ctx, id)
  const lines: CardLine[] = [{ label: "User", value: label }]
  const now = row ? roleOf(row) : null
  lines.push({ label: "Role now", value: now ?? "unknown" })
  lines.push({ label: "Role after", value: "user" })
  if (row && now !== "admin") {
    lines.push({
      label: "Warning",
      value: `This user is not an admin (their role is ${now}). The request sets the role to user whatever it is, so it would take away that role.`,
    })
  }
  if (id && id === ctx.adminId) lines.push({ label: "Warning", value: "This is your own account: you would lose your own admin access." })
  const admins = await adminCount(ctx)
  if (admins !== null && admins <= 1 && now === "admin") {
    lines.push({ label: "Warning", value: "This is the only admin. Nothing in the request stops it, and nobody would be left to manage the platform." })
  }
  lines.push({ label: "Record", value: "The change is written to the admin history. The user is not notified." })
  return { summary: "Remove admin access from a user (role becomes user)", lines }
}

async function removeUserCard(i: EntryInput, ctx: CardCtx): Promise<Card> {
  const id = str(asBody(i).userId)
  const { row, label } = await who(ctx, id)
  const lines: CardLine[] = [{ label: "User", value: label }]
  if (id && id === ctx.adminId) lines.push({ label: "Problem", value: "You cannot delete your own account. The request is refused." })
  if (row && roleOf(row) === "admin") {
    lines.push({ label: "Problem", value: "Admin accounts cannot be deleted. Remove their admin role first. The request is refused." })
  }
  if (row) lines.push({ label: "Role", value: roleOf(row) })
  if (!row && id) lines.push({ label: "Note", value: "No profile row was found for this id (an account may still exist in sign-in only)." })
  const wallet = id ? await readRow(() => ctx.db.from("wallets").select("balance").eq("user_id", id).maybeSingle()) : null
  if (wallet) lines.push({ label: "Wallet balance deleted with the account", value: ghs(wallet.balance) })
  const orders = id ? await readCount(() => ctx.db.from("orders").select("id", { count: "exact", head: true }).eq("user_id", id)) : null
  if (orders !== null) lines.push({ label: "Orders deleted", value: String(orders) })
  const shops = id ? await readCount(() => ctx.db.from("user_shops").select("id", { count: "exact", head: true }).eq("user_id", id)) : null
  if (shops !== null) lines.push({ label: "Shops deleted", value: String(shops) })
  lines.push({
    label: "Danger",
    value:
      "Permanently deletes the account and its data: notifications, complaints, transactions, withdrawal requests, orders, AFA orders, the wallet (any balance is lost, nothing is paid out), and for each shop its packages, customers, orders, profits, balance and invites (sub-agents of the shop are detached). Then the sign-in account is deleted. This cannot be undone.",
  })
  lines.push({ label: "Record", value: "One entry is written to the admin history first, with the account's email, phone and role; if that fails nothing is deleted." })
  return { summary: "Permanently delete a user account and all its data", lines }
}

async function changePasswordCard(i: EntryInput, ctx: CardCtx): Promise<Card> {
  const id = str(asBody(i).userId)
  const { label } = await who(ctx, id)
  return {
    summary: "Set a new password for a user",
    lines: [
      { label: "User", value: label },
      { label: "New password", value: "Typed in the secure box on this card; the assistant never sees it" },
      { label: "Effect", value: "Replaces their password at once and ends every signed-in session they have, on all devices." },
      { label: "Notice", value: "The user is not told. Give them the new password yourself, or send a reset link instead." },
      { label: "Rules", value: "8 to 128 characters." },
    ],
  }
}

async function updateUserCard(i: EntryInput, ctx: CardCtx): Promise<Card> {
  const b = asBody(i)
  const id = str(b.userId)
  const { row, label } = await who(ctx, id)
  const lines: CardLine[] = [{ label: "User", value: label }]
  const name = (r: Obj | null) => [r?.first_name, r?.last_name].map((s) => str(s).trim()).filter(Boolean).join(" ")
  let changes = 0
  if (b.firstName !== undefined || b.lastName !== undefined) {
    const first = b.firstName !== undefined ? str(b.firstName) : str(row?.first_name)
    const last = b.lastName !== undefined ? str(b.lastName) : str(row?.last_name)
    lines.push({ label: "Name", value: `${name(row) || "(none)"} -> ${[first, last].filter(Boolean).join(" ") || "(blank)"}` })
    changes++
  }
  if (b.email !== undefined) {
    const e = str(b.email)
    // The NEW address is shown in full so a swapped-in attacker address cannot hide; the current one stays masked.
    lines.push({ label: "Email", value: `${str(row?.email) ? maskEmail(str(row?.email)) : "(none)"} -> ${e}` })
    lines.push({ label: "Sign-in", value: "The sign-in email changes too, so the user must use the new address to sign in." })
    changes++
  }
  if (typeof b.phoneNumber === "string" && b.phoneNumber.trim() !== "") {
    lines.push({ label: "Phone", value: `${row?.phone_number ? maskAny(row.phone_number) : "(none)"} -> ${b.phoneNumber.trim()}` })
    lines.push({
      label: "Phone checks",
      value: "The phone-verified flag is not reset. Orders, refunds and bots that match accounts by phone will use the new number.",
    })
    changes++
  }
  if (row && roleOf(row) === "admin") lines.push({ label: "Danger", value: "This changes the sign-in details of an admin account." })
  if (changes === 0) lines.push({ label: "Problem", value: "No field to change was given, so nothing will change." })
  lines.push({ label: "Record", value: "No entry is written to the admin history for this change. The user is not notified." })
  return { summary: "Change a user's name, email or phone number", lines }
}

async function forceLogoutCard(i: EntryInput, ctx: CardCtx): Promise<Card> {
  const { label } = await who(ctx, str(i.params?.id))
  return {
    summary: "Sign a user out of every device",
    lines: [
      { label: "User", value: label },
      { label: "Effect", value: "Ends every signed-in session of this user. They can sign straight back in with their password." },
      { label: "Not a lockout", value: "API keys and the WhatsApp bot keep working. To lock a user out, suspend them instead." },
      { label: "Record", value: "Written to the admin history with the number of sessions ended." },
    ],
  }
}

async function passwordResetCard(i: EntryInput, ctx: CardCtx): Promise<Card> {
  const id = str(i.params?.id)
  const { row, label } = await who(ctx, id)
  const lines: CardLine[] = [{ label: "User", value: label }]
  if (row && !str(row.email)) lines.push({ label: "Problem", value: "This user has no email address, so the request is refused." })
  else if (row) lines.push({ label: "Sent to", value: maskEmail(str(row.email)) })
  const recent = id
    ? await readCount(() => ctx.db.from("password_reset_requests").select("id", { count: "exact", head: true }).eq("user_id", id))
    : null
  lines.push({
    label: "Effect",
    value: `Emails the user a password reset link that works for ${RESET_TOKEN_TTL_MINUTES} minutes. Their current password and sessions are not touched until they use it.`,
  })
  lines.push({
    label: "Limit",
    value: `At most ${RESET_MAX_PER_HOUR} reset links per account per hour; more is refused.${recent !== null ? ` Reset requests on file for this user: ${recent}.` : ""}`,
  })
  lines.push({ label: "Record", value: "Written to the admin history. The link goes to the user's inbox only; you never see it." })
  return { summary: "Email a user a password reset link", lines }
}

async function phoneVerifiedCard(i: EntryInput, ctx: CardCtx): Promise<Card> {
  const id = str(i.params?.id)
  const want = asBody(i).verified === true
  const { row, label } = await who(ctx, id)
  const cur = id ? await readRow(() => ctx.db.from("users").select("phone_verified").eq("id", id).maybeSingle()) : null
  const lines: CardLine[] = [{ label: "User", value: label }]
  if (row?.phone_number) lines.push({ label: "Phone", value: maskAny(row.phone_number) })
  lines.push({ label: "Phone verified", value: `${cur ? (cur.phone_verified === true ? "yes" : "no") : "unknown"} -> ${want ? "yes" : "no"}` })
  if (want) {
    lines.push({
      label: "Money",
      value:
        "USSD and storefront refunds for this phone number are paid into the verified account. The request is refused if another account already has this number verified, and when this user has no phone number.",
    })
  } else {
    lines.push({
      label: "Effect",
      value: "Actions that need a verified phone are blocked once any grace period the user still has runs out.",
    })
  }
  lines.push({ label: "Record", value: "Written to the admin history. The user is not notified." })
  return { summary: want ? "Mark a user's phone number as verified" : "Mark a user's phone number as not verified", lines }
}

async function noteCreateCard(i: EntryInput, ctx: CardCtx): Promise<Card> {
  const { label } = await who(ctx, str(i.params?.id))
  const text = str(asBody(i).body).trim()
  return {
    summary: "Add an internal admin note to a user",
    lines: [
      { label: "User", value: label },
      { label: "Note", value: text.length > 120 ? `${text.slice(0, 120)}...` : text || "(empty)" },
      { label: "Visibility", value: "Admins only. The user never sees it. The note is also copied into the admin history." },
    ],
  }
}

async function noteEditCard(i: EntryInput, ctx: CardCtx): Promise<Card> {
  const { label } = await who(ctx, str(i.params?.id))
  const noteId = str(i.params?.noteId)
  const note = noteId ? await readRow(() => ctx.db.from("admin_user_notes").select("body, author_id").eq("id", noteId).maybeSingle()) : null
  const text = str(asBody(i).body).trim()
  const lines: CardLine[] = [{ label: "User", value: label }]
  if (note) lines.push({ label: "Now", value: str(note.body).slice(0, 120) })
  lines.push({ label: "New text", value: text.length > 120 ? `${text.slice(0, 120)}...` : text || "(empty)" })
  if (note && str(note.author_id) !== ctx.adminId) {
    lines.push({ label: "Problem", value: "Only the admin who wrote a note can edit it, and that is not you. The request is refused." })
  }
  lines.push({ label: "Record", value: "The old and new text are written to the admin history." })
  return { summary: "Edit one of your admin notes on a user", lines }
}

async function noteDeleteCard(i: EntryInput, ctx: CardCtx): Promise<Card> {
  const { label } = await who(ctx, str(i.params?.id))
  const noteId = str(i.params?.noteId)
  const note = noteId ? await readRow(() => ctx.db.from("admin_user_notes").select("body").eq("id", noteId).maybeSingle()) : null
  return {
    summary: "Delete an admin note on a user",
    lines: [
      { label: "User", value: label },
      { label: "Note", value: note ? str(note.body).slice(0, 120) : short(noteId) },
      { label: "Effect", value: "Deletes the note for good. Any admin may delete any note. The deleted text stays in the admin history." },
    ],
  }
}

async function tagsCard(i: EntryInput, ctx: CardCtx): Promise<Card> {
  const id = str(i.params?.id)
  const { label } = await who(ctx, id)
  const b = asBody(i)
  const add = listOf(b.add)
  const remove = listOf(b.remove)
  const lines: CardLine[] = [{ label: "User", value: label }]
  const cur = id ? await readRows(() => ctx.db.from("admin_user_tags").select("tag").eq("user_id", id)) : null
  if (cur) lines.push({ label: "Tags now", value: cur.map((r) => str(r.tag)).join(", ") || "none" })
  if (add.length) lines.push({ label: "Add", value: add.join(", ") })
  if (remove.length) lines.push({ label: "Remove", value: remove.join(", ") })
  lines.push({ label: "Limit", value: "At most 20 tags per user. Tags are internal labels for admins; the user never sees them." })
  return { summary: "Add or remove admin tags on a user", lines }
}

async function customPricesCard(i: EntryInput, ctx: CardCtx): Promise<Card> {
  const id = str(i.params?.id)
  const { row, label } = await who(ctx, id)
  const b = asBody(i)
  const prices = Array.isArray(b.prices) ? (b.prices as Obj[]) : []
  const cleared = prices.filter((p) => p.price === null).length
  const set = prices.length - cleared
  const cur = id ? await readRow(() => ctx.db.from("users").select("pricing_mode").eq("id", id).maybeSingle()) : null
  const lines: CardLine[] = [{ label: "User", value: label }]
  if (row) lines.push({ label: "Role", value: roleOf(row) })
  if (typeof b.pricing_mode === "string") {
    lines.push({ label: "Pricing mode", value: `${str(cur?.pricing_mode) || "role"} -> ${b.pricing_mode}` })
  }
  if (prices.length) lines.push({ label: "Custom prices", value: `${set} set, ${cleared} cleared` })
  lines.push({
    label: "Money",
    value:
      "Changes what this user pays for those packages from now on. In custom mode a custom price replaces their role price for each package that has one. Orders already placed are not changed.",
  })
  lines.push({ label: "Record", value: "Saved in one step and written to the admin history. The user is not notified." })
  return { summary: "Change a user's pricing mode or custom package prices", lines }
}

// ---------------------------------------------------------------------------------------------------------------------
// Cards: roles hub
// ---------------------------------------------------------------------------------------------------------------------

type RoleRow = { id: string; slug: string; name: string; rank: number | null; is_system: boolean; archived_at: string | null }

async function roleById(ctx: CardCtx, id: string): Promise<RoleRow | null> {
  if (!id) return null
  const r = await readRow(() => ctx.db.from("roles").select("id, slug, name, rank, is_system, archived_at").eq("id", id).maybeSingle())
  return r ? (r as unknown as RoleRow) : null
}

async function memberCount(ctx: CardCtx, slug: string): Promise<number | null> {
  return readCount(() => ctx.db.from("users").select("id", { count: "exact", head: true }).eq("role", slug))
}

const roleName = (r: RoleRow | null, id: string) => (r ? `${r.name} (${r.slug})` : short(id))

async function roleCreateCard(i: EntryInput, ctx: CardCtx): Promise<Card> {
  const b = asBody(i)
  const slug = str(b.slug)
  const lines: CardLine[] = [
    { label: "Role", value: `${str(b.name)} (${slug})` },
    { label: "Rank", value: String(b.rank ?? "") },
    { label: "Reason", value: str(b.reason) },
  ]
  const clone = str(b.clone_from)
  if (clone) {
    lines.push({ label: "Copied from", value: `${clone}: its rights, look, package prices and service rates are copied (prices are not checked against cost)` })
  } else {
    lines.push({ label: "Starts with", value: "The same rights as Dealer, the default look, and no prices or rates of its own" })
  }
  const taken = slug ? await readRows(() => ctx.db.from("roles").select("slug").eq("slug", slug)) : null
  if (taken && taken.length) lines.push({ label: "Problem", value: "A role with this slug already exists (retired slugs stay taken). The request is refused." })
  const rank = typeof b.rank === "number" ? b.rank : null
  const used = rank !== null ? await readRows(() => ctx.db.from("roles").select("slug, archived_at").eq("rank", rank)) : null
  if (used && used.some((r) => !r.archived_at)) lines.push({ label: "Problem", value: "That rank is already used by a live role. The request is refused." })
  lines.push({ label: "Rule", value: "A new role must rank above Dealer. It starts with no members." })
  if (!CUSTOM_ROLE_ASSIGNMENT_ENABLED) {
    lines.push({
      label: "Feature switch",
      value: "Custom roles are switched off for assignment: the role can be created and edited, but no user can be given it yet.",
    })
  }
  lines.push({ label: "Record", value: "Written to the role's change history." })
  return { summary: "Create a custom role", lines }
}

async function roleUpdateCard(i: EntryInput, ctx: CardCtx): Promise<Card> {
  const id = str(i.params?.id)
  const role = await roleById(ctx, id)
  const b = asBody(i)
  const lines: CardLine[] = [{ label: "Role", value: roleName(role, id) }]
  if (b.name !== undefined) lines.push({ label: "Name", value: `${role?.name ?? "?"} -> ${str(b.name)}` })
  if (b.description !== undefined) lines.push({ label: "Description", value: b.description === null ? "(cleared)" : str(b.description) })
  if (b.badge_color !== undefined) lines.push({ label: "Badge colour", value: str(b.badge_color) })
  if (b.icon !== undefined) lines.push({ label: "Icon", value: str(b.icon) })
  if (b.theme !== undefined) lines.push({ label: "Look", value: `Skin: ${str((b.theme as Obj)?.skin)}` })
  if (role?.slug === "admin") lines.push({ label: "Problem", value: "The admin role cannot be edited. The request is refused." })
  if (role?.slug === "sub_agent" && b.theme !== undefined) lines.push({ label: "Problem", value: "The sub-agent look cannot be changed. The request is refused." })
  lines.push({ label: "Effect", value: "Changes how the role looks and is named for its members and in the admin pages. No prices or rights change." })
  lines.push({ label: "Record", value: "Written to the role's change history." })
  return { summary: "Edit a role's name and look", lines }
}

async function roleArchiveCard(i: EntryInput, ctx: CardCtx): Promise<Card> {
  const id = str(i.params?.id)
  const role = await roleById(ctx, id)
  const lines: CardLine[] = [{ label: "Role", value: roleName(role, id) }, { label: "Reason", value: str(asBody(i).reason) }]
  const n = role ? await memberCount(ctx, role.slug) : null
  if (n !== null) lines.push({ label: "Members", value: String(n) })
  if (n !== null && n > 0) lines.push({ label: "Problem", value: `The role still has ${n} members. Move them first; the request is refused.` })
  if (role?.archived_at) lines.push({ label: "Problem", value: "This role is already archived." })
  lines.push({
    label: "Danger",
    value:
      "Retires the role: it leaves the ladder, can no longer be given to anyone, and its slug stays reserved. Prices and rights it had stop applying.",
  })
  lines.push({ label: "Record", value: "Written to the role's change history." })
  return { summary: "Archive (retire) a custom role", lines }
}

const FIXED_SLUGS = new Set(["user", "admin", "sub_agent"])

async function roleMoveCard(i: EntryInput, ctx: CardCtx): Promise<Card> {
  const id = str(i.params?.id)
  const b = asBody(i)
  const dir = b.direction === "down" ? "down" : "up"
  const role = await roleById(ctx, id)
  const lines: CardLine[] = [{ label: "Role", value: roleName(role, id) }, { label: "Direction", value: dir === "up" ? "Up (higher rank)" : "Down (lower rank)" }]
  const all = await readRows(() => ctx.db.from("roles").select("id, slug, name, rank, is_system, archived_at"))
  let refused = ""
  if (role) {
    if (FIXED_SLUGS.has(role.slug) || role.slug === "dealer") refused = "That role cannot be moved."
    else if (role.archived_at || role.rank == null) refused = "Only live ranked roles can be moved."
    else if (all) {
      const rows = all as unknown as RoleRow[]
      const dealer = rows.find((r) => r.slug === "dealer")
      const dealerRank = dealer?.rank ?? null
      const rank = role.rank
      if (dealerRank == null) refused = "The ladder could not be read."
      else {
        const cands = rows
          .filter(
            (r) =>
              r.id !== role.id && !r.archived_at && r.rank != null && !FIXED_SLUGS.has(r.slug) && r.slug !== "dealer" &&
              (r.rank as number) > dealerRank && rank > dealerRank && (dir === "up" ? (r.rank as number) > rank : (r.rank as number) < rank),
          )
          .sort((a, c) => (dir === "up" ? (a.rank as number) - (c.rank as number) : (c.rank as number) - (a.rank as number)))
        const n = cands[0]
        if (!n) refused = "Already at the end of the ladder."
        else lines.push({ label: "Swaps places with", value: `${n.name} (${n.slug}): rank ${rank} and ${n.rank} are exchanged` })
      }
    }
  }
  if (refused) lines.push({ label: "Problem", value: `${refused} The request is refused.` })
  lines.push({
    label: "Money",
    value:
      "A role with no price for a package uses the price of the next lower-ranked role, so changing the order can change what members of both roles pay for packages that have no price of their own.",
  })
  lines.push({ label: "Reason", value: str(b.reason) })
  lines.push({ label: "Record", value: "Written to the role's change history." })
  return { summary: "Move a role up or down the ladder", lines }
}

async function membersMoveCard(i: EntryInput, ctx: CardCtx): Promise<Card> {
  const b = asBody(i)
  const ids = listOf(b.user_ids)
  const to = str(b.to_role)
  const lines: CardLine[] = [{ label: "Users selected", value: String(ids.length) }, { label: "Move to role", value: to }]
  const rows = ids.length ? await readRows(() => ctx.db.from("users").select("id, role").in("id", ids)) : []
  if (rows) {
    const byId = new Map(rows.map((r) => [str(r.id), str(r.role) || "user"]))
    const missing = ids.filter((x) => !byId.has(x)).length
    const admins = [...byId.values()].filter((r) => r === "admin").length
    const already = [...byId.values()].filter((r) => r === to).length
    const movable = byId.size - admins - already
    const tally = new Map<string, number>()
    for (const r of byId.values()) tally.set(r, (tally.get(r) ?? 0) + 1)
    lines.push({ label: "Their roles now", value: [...tally.entries()].map(([k, n]) => `${k} x${n}`).join(", ") || "none found" })
    lines.push({ label: "Will be skipped", value: `${missing} not found, ${admins} admin accounts (never moved here), ${already} already in this role` })
    lines.push({ label: "Will be moved", value: String(movable) })
  } else {
    lines.push({ label: "Will be moved", value: "Count unavailable" })
  }
  if (to !== "user" && to !== "dealer" && !CUSTOM_ROLE_ASSIGNMENT_ENABLED) {
    lines.push({ label: "Feature switch", value: "Custom roles can't be assigned yet, so every user would be skipped with that message." })
  }
  if (to === "dealer") {
    lines.push({ label: "Money", value: "Moving a user to dealer raises their shop package margins so their selling prices stay the same. Sub-agents cannot become dealers and are skipped." })
  } else {
    lines.push({ label: "Money", value: "Their shop package margins are re-balanced so shop selling prices stay the same; what the user pays for packages follows the new role's prices." })
  }
  lines.push({ label: "Notice", value: "Each moved user gets a push notification saying their account role has been updated." })
  lines.push({ label: "Reason", value: str(b.reason) })
  lines.push({ label: "Record", value: "One admin-history entry per user moved." })
  return { summary: "Move several users into another role", lines }
}

async function rolePermissionsCard(i: EntryInput, ctx: CardCtx): Promise<Card> {
  const id = str(i.params?.id)
  const role = await roleById(ctx, id)
  const b = asBody(i)
  const want = listOf(b.capabilities)
  const lines: CardLine[] = [{ label: "Role", value: roleName(role, id) }]
  const cur = id ? await readRows(() => ctx.db.from("role_permissions").select("capability").eq("role_id", id)) : null
  if (cur) {
    const have = cur.map((r) => str(r.capability))
    const added = want.filter((c) => !have.includes(c))
    const removed = have.filter((c) => !want.includes(c))
    lines.push({ label: "Rights after", value: want.join(", ") || "none" })
    lines.push({ label: "Gains", value: added.join(", ") || "nothing" })
    lines.push({ label: "Loses", value: removed.join(", ") || "nothing" })
  } else {
    lines.push({ label: "Rights after", value: want.join(", ") || "none" })
  }
  const n = role ? await memberCount(ctx, role.slug) : null
  lines.push({ label: "Members affected", value: n === null ? "Count unavailable" : String(n) })
  if (role && (role.slug === "admin" || role.slug === "sub_agent")) {
    lines.push({ label: "Problem", value: "This role's rights are fixed and cannot be edited. The request is refused." })
  }
  lines.push({
    label: "Danger",
    value: "Sets exactly this list of rights for the role (replacing the old list). Members gain or lose access to those features at once; other servers pick it up within about a minute.",
  })
  lines.push({ label: "Reason", value: str(b.reason) })
  lines.push({ label: "Record", value: "Written to the role's change history." })
  return { summary: "Set the rights of a role", lines }
}

async function rolePricesCard(i: EntryInput, ctx: CardCtx): Promise<Card> {
  const id = str(i.params?.id)
  const role = await roleById(ctx, id)
  const b = asBody(i)
  const changes = Array.isArray(b.changes) ? (b.changes as Obj[]) : []
  const ids = changes.map((c) => str(c.package_id)).filter(Boolean)
  const cleared = changes.filter((c) => c.price === null).length
  const lines: CardLine[] = [{ label: "Role", value: roleName(role, id) }]
  lines.push({ label: "Package prices to change", value: `${changes.length} (${changes.length - cleared} set, ${cleared} cleared)` })
  const [pkgs, cur, costs] = ids.length
    ? await Promise.all([
        readRows(() => ctx.db.from("packages").select("id, network, name").in("id", ids)),
        readRows(() => ctx.db.from("role_package_prices").select("package_id, price").eq("role_id", id).in("package_id", ids)),
        readRows(() => ctx.db.from("package_costs").select("package_id, cost_price").in("package_id", ids)),
      ])
    : [[], [], []]
  const pkgName = new Map((pkgs ?? []).map((p) => [str(p.id), `${str(p.network)} ${str(p.name)}`.trim()]))
  const now = new Map((cur ?? []).map((p) => [str(p.package_id), Number(p.price)]))
  const cost = new Map((costs ?? []).map((p) => [str(p.package_id), Number(p.cost_price)]))
  for (const c of changes.slice(0, 5)) {
    const pid = str(c.package_id)
    const before = now.has(pid) ? ghs(now.get(pid)) : "no price of its own"
    lines.push({ label: pkgName.get(pid) || short(pid), value: `${before} -> ${c.price === null ? "cleared" : ghs(c.price)}` })
  }
  if (changes.length > 5) lines.push({ label: "More", value: `and ${changes.length - 5} more packages` })
  const below = changes.filter((c) => typeof c.price === "number" && cost.has(str(c.package_id)) && (c.price as number) < (cost.get(str(c.package_id)) as number)).length
  if (below > 0 && b.loss_override !== true) {
    lines.push({ label: "Problem", value: `${below} prices are below cost. Without the loss override the request is refused.` })
  } else if (below > 0) {
    lines.push({ label: "Warning", value: `Loss override is on: ${below} prices below cost will be saved, so each sale of them loses money.` })
  }
  const n = role ? await memberCount(ctx, role.slug) : null
  lines.push({
    label: "Money",
    value: `Changes what members of this role pay${n === null ? "" : ` (${n} members now)`}, and roles ranked above it that have no price of their own for these packages.`,
  })
  if (role && (role.slug === "admin" || role.slug === "sub_agent")) lines.push({ label: "Problem", value: "This role has no price tier. The request is refused." })
  lines.push({ label: "Reason", value: str(b.reason) })
  lines.push({ label: "Record", value: "Written to the role's change history." })
  return { summary: "Change a role's package prices", lines }
}

async function roleRatesCard(i: EntryInput, ctx: CardCtx): Promise<Card> {
  const id = str(i.params?.id)
  const role = await roleById(ctx, id)
  const b = asBody(i)
  const changes = Array.isArray(b.changes) ? (b.changes as Obj[]) : []
  const lines: CardLine[] = [{ label: "Role", value: roleName(role, id) }]
  const cur = id ? await readRows(() => ctx.db.from("role_service_rates").select("service_key, value").eq("role_id", id)) : null
  const now = new Map((cur ?? []).map((r) => [str(r.service_key), Number(r.value)]))
  const label = new Map(HUB_SERVICE_KEYS.map((k) => [k.key, k.label]))
  for (const c of changes) {
    const key = str(c.service_key)
    const before = now.has(key) ? `${now.get(key)}%` : "no rate of its own"
    lines.push({ label: label.get(key) ?? key, value: `${before} -> ${c.value === null ? "cleared" : `${c.value}%`}` })
  }
  if (role?.is_system) lines.push({ label: "Problem", value: "System role rates cannot be edited. The request is refused." })
  const n = role ? await memberCount(ctx, role.slug) : null
  lines.push({
    label: "Money",
    value: `Changes the airtime fee or the cashback share members of this role get${n === null ? "" : ` (${n} members now)`}, on their next purchase.`,
  })
  lines.push({ label: "Reason", value: str(b.reason) })
  lines.push({ label: "Record", value: "Written to the role's change history." })
  return { summary: "Change a role's airtime fees and cashback shares", lines }
}

// ---------------------------------------------------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------------------------------------------------

const userIdParams = { id: "uuid" } as const

export const USERS_ENTRIES: CatalogEntry[] = [
  // ---- user lookups -----------------------------------------------------------------------------------------------
  {
    id: "users.list",
    area: "users",
    ...where("/admin/users"),
    summary: "Search and filter users by name, phone, role, status, shop or signup date, with wallet and shop balances.",
    method: "GET",
    path: "/api/admin/users",
    query: z
      .object({
        q: z.string().max(100).optional(),
        role: z.enum(["user", "dealer", "sub_agent", "admin"]).optional(),
        suspended: z.boolean().optional(),
        hasShop: z.boolean().optional(),
        pricingMode: z.enum(["role", "custom"]).optional(),
        from: dateText.optional(),
        to: dateText.optional(),
        tag: z.string().max(32).optional(),
        sort: z.enum(["created_at", "balance", "email", "shop_balance", "last_sign_in_at"]).optional(),
        dir: z.enum(["asc", "desc"]).optional(),
        page: pageNo.optional(),
        pageSize: drawerPageSize.optional(),
      })
      .strict(),
    kind: "lookup",
    risk: "normal",
    auth: "admin",
    timeoutMs: 30000,
    resultKeep: [
      "total",
      "page",
      "pageSize",
      "users[].id",
      "users[].first_name",
      "users[].last_name",
      "users[].phoneNumber",
      "users[].role",
      "users[].is_suspended",
      "users[].walletBalance",
      "users[].shopBalance",
      "users[].pricing_mode",
      "users[].created_at",
      "users[].shop.shop_name",
      "users[].tags",
    ],
  },
  {
    id: "users.profile",
    area: "users",
    ...where("/admin/users"),
    summary: "One user's profile: name, phone, role, suspension, pricing mode, phone verification and wallet balance.",
    method: "GET",
    path: "/api/admin/users/:id/profile",
    params: userIdParams,
    kind: "lookup",
    risk: "normal",
    auth: "admin",
    resultKeep: [
      "id",
      "firstName",
      "lastName",
      "phoneNumber",
      "role",
      "pricingMode",
      "isSuspended",
      "suspension",
      "phoneVerified",
      "phoneVerifyDeadline",
      "createdAt",
      "hasProfile",
      "walletBalance",
      "walletRows",
    ],
  },
  {
    id: "users.stats",
    area: "users",
    ...where("/admin/users"),
    summary: "One user's totals: wallet, orders, shop and withdrawals.",
    method: "GET",
    path: "/api/admin/users/:id/stats",
    params: userIdParams,
    kind: "lookup",
    risk: "normal",
    auth: "admin",
    resultKeep: ["userId", "wallet", "orders", "shop", "withdrawals"],
  },
  {
    id: "users.orders",
    area: "users",
    ...where("/admin/users"),
    summary: "One user's orders across every order type, newest first, with counts per type.",
    method: "GET",
    path: "/api/admin/users/:id/orders",
    params: userIdParams,
    query: z
      .object({
        page: pageNo.optional(),
        pageSize: drawerPageSize.optional(),
        source: z.enum(["data", "api", "standard", "airtime", "bills", "results", "afa"]).optional(),
        status: z
          .enum(["pending", "pending_payment", "processing", "completed", "delivered", "failed", "refunded", "cancelled"])
          .optional(),
      })
      .strict(),
    kind: "lookup",
    risk: "normal",
    auth: "admin",
    timeoutMs: 30000,
    resultKeep: [
      "total",
      "totalCapped",
      "hasMore",
      "counts",
      "page",
      "pageSize",
      "rows[].source",
      "rows[].id",
      "rows[].reference",
      "rows[].description",
      "rows[].amount",
      "rows[].status",
      "rows[].payment_status",
      "rows[].created_at",
    ],
  },
  {
    id: "users.transactions",
    area: "users",
    ...where("/admin/users"),
    summary: "One user's wallet ledger, newest first, with the current balance and running totals.",
    method: "GET",
    path: "/api/admin/users/:id/transactions",
    params: userIdParams,
    query: z
      .object({
        page: pageNo.optional(),
        pageSize: drawerPageSize.optional(),
        type: z.enum(["credit", "debit", "refund", "admin", "clawback"]).optional(),
      })
      .strict(),
    kind: "lookup",
    risk: "normal",
    auth: "admin",
    resultKeep: [
      "total",
      "page",
      "pageSize",
      "wallet",
      "rows[].id",
      "rows[].type",
      "rows[].amount",
      "rows[].status",
      "rows[].description",
      "rows[].reference_id",
      "rows[].balance_before",
      "rows[].balance_after",
      "rows[].created_at",
    ],
  },
  {
    id: "users.audit",
    area: "users",
    ...where("/admin/users"),
    summary: "The admin history of one user: who did what to the account and when, newest first.",
    method: "GET",
    path: "/api/admin/users/:id/audit",
    params: userIdParams,
    query: z.object({ page: pageNo.optional(), pageSize: drawerPageSize.optional() }).strict(),
    kind: "lookup",
    risk: "normal",
    auth: "admin",
    resultKeep: [
      "total",
      "page",
      "pageSize",
      "rows[].id",
      "rows[].action",
      "rows[].admin_id",
      "rows[].created_at",
      "rows[].old_value.role",
      "rows[].new_value.role",
      "rows[].new_value.reason",
    ],
  },
  {
    id: "users.signals",
    area: "users",
    ...where("/admin/users"),
    summary: "Activity signals for one user: last order, phone verified, blacklisted and risk flags.",
    method: "GET",
    path: "/api/admin/users/:id/signals",
    params: userIdParams,
    kind: "lookup",
    risk: "normal",
    auth: "admin",
    resultKeep: ["signals.lastOrderAt", "signals.phoneVerified", "signals.phoneBlacklisted", "signals.flags"],
  },
  {
    id: "users.shop",
    area: "users",
    ...where("/admin/users"),
    summary: "A user's shop: name, status, customers, profit balance, parent shop, sub-agents and withdrawals.",
    method: "GET",
    path: "/api/admin/users/:id/shop",
    params: userIdParams,
    query: z.object({ part: z.enum(["all", "sub_agents", "withdrawals"]).optional(), page: pageNo.optional(), pageSize: drawerPageSize.optional() }).strict(),
    kind: "lookup",
    risk: "normal",
    auth: "admin",
    resultKeep: [
      "shop.id",
      "shop.shop_name",
      "shop.shop_slug",
      "shop.is_active",
      "shop.created_at",
      "shop.customers",
      "shop.balance",
      "parent.id",
      "parent.shop_name",
      "parent.user_id",
      "subAgents.total",
      "subAgents.page",
      "subAgents.rows[].user_id",
      "subAgents.rows[].shop_name",
      "subAgents.rows[].created_at",
      "withdrawals.total",
      "withdrawals.page",
      "withdrawals.rows[].id",
      "withdrawals.rows[].amount",
      "withdrawals.rows[].net_amount",
      "withdrawals.rows[].status",
      "withdrawals.rows[].withdrawal_method",
      "withdrawals.rows[].reference_code",
      "withdrawals.rows[].created_at",
    ],
  },
  {
    id: "users.notes_list",
    area: "users",
    ...where("/admin/users"),
    summary: "The internal admin notes on one user, newest first.",
    method: "GET",
    path: "/api/admin/users/:id/notes",
    params: userIdParams,
    kind: "lookup",
    risk: "normal",
    auth: "admin",
    resultKeep: ["limit", "notes[].id", "notes[].body", "notes[].author_id", "notes[].created_at", "notes[].updated_at"],
  },
  {
    id: "users.tags_get",
    area: "users",
    ...where("/admin/users"),
    summary: "The admin tags on one user.",
    method: "GET",
    path: "/api/admin/users/:id/tags",
    params: userIdParams,
    kind: "lookup",
    risk: "normal",
    auth: "admin",
    resultKeep: ["tags"],
  },
  {
    id: "users.custom_prices_get",
    area: "users",
    ...where("/admin/users"),
    summary: "A user's pricing mode and every package with the role price and any custom price.",
    method: "GET",
    path: "/api/admin/users/:id/custom-prices",
    params: userIdParams,
    kind: "lookup",
    risk: "normal",
    auth: "admin",
    timeoutMs: 30000,
    resultKeep: [
      "user.id",
      "user.role",
      "user.pricing_mode",
      "packages[].id",
      "packages[].network",
      "packages[].size",
      "packages[].price",
      "packages[].dealer_price",
      "packages[].role_price",
      "packages[].custom_price",
      "packages[].is_available",
    ],
  },
  {
    id: "users.phone_audit",
    area: "users",
    ...where("/admin/user-phone-audit"),
    summary: "Accounts with a missing, invalid or unverified phone number, with wallet balance and order count so real customers are not removed.",
    method: "GET",
    path: "/api/admin/users/phone-audit",
    query: z.object({ bucket: z.enum(["missing", "invalid", "unverified"]).optional(), page: pageNo.optional() }).strict(),
    kind: "lookup",
    risk: "normal",
    auth: "admin",
    timeoutMs: 45000,
    resultKeep: [
      "bucket",
      "page",
      "pages",
      "total",
      "counts",
      "users[].id",
      "users[].phone_number",
      "users[].phone_verified",
      "users[].created_at",
      "users[].bucket",
      "users[].wallet_balance",
      "users[].order_count",
    ],
  },
  {
    id: "users.debtors",
    area: "users",
    ...where("/admin/debtors"),
    summary: "Users whose wallet balance is negative, with the total owed.",
    method: "GET",
    path: "/api/admin/debtors",
    kind: "lookup",
    risk: "normal",
    auth: "admin",
    resultKeep: ["totalOwed", "debtors[].userId", "debtors[].firstName", "debtors[].role", "debtors[].balance", "debtors[].updatedAt"],
  },
  {
    id: "users.signup_sources",
    area: "users",
    ...where("/admin/settings"),
    summary: "Sign-ups of the last 30 days grouped by the page they first landed on.",
    method: "GET",
    path: "/api/admin/signup-sources",
    kind: "lookup",
    risk: "normal",
    auth: "admin",
    timeoutMs: 30000,
    resultKeep: ["since", "total", "truncated", "rows"],
  },

  // ---- account changes --------------------------------------------------------------------------------------------
  {
    id: "users.update_balance",
    area: "users",
    ...where("/admin/users"),
    summary: "Credit or debit a user's wallet with a written reason. The user is told by notification, SMS, email and push.",
    method: "POST",
    path: "/api/admin/update-balance",
    body: z
      .object({
        userId: uuid,
        type: z.enum(["credit", "debit"]),
        amount: z.number().positive().max(50000),
        reason: reason5,
        expectedBalance: z.number().optional(),
      })
      .strict(),
    kind: "change",
    risk: "money",
    auth: "admin",
    typedCard: "prepare_wallet_adjustment",
  },
  {
    id: "users.suspend",
    area: "users",
    ...where("/admin/users"),
    summary: "Suspend or unsuspend a user. A suspended user cannot sign in and is told by SMS, email and push.",
    method: "POST",
    path: "/api/admin/users/suspend",
    body: z.object({ userId: uuid, action: z.enum(["suspend", "unsuspend"]), reason: z.string().max(500).optional() }).strict(),
    kind: "change",
    risk: "danger",
    auth: "admin",
    typedCard: "prepare_user_suspension",
  },
  {
    id: "users.update_role",
    area: "users",
    ...where("/admin/users"),
    summary: "Change a user's system role (user, dealer, sub-agent or admin). A dealer upgrade raises shop margins to keep selling prices.",
    method: "POST",
    path: "/api/admin/users/update-role",
    body: z.object({ userId: uuid, role: roleSlug }).strict(),
    kind: "change",
    risk: "danger",
    auth: "admin",
    typedCard: "prepare_role_change",
  },
  {
    id: "users.set_admin",
    area: "users",
    ...where("/admin/users"),
    summary: "Make a user (by id) a full admin.",
    method: "POST",
    path: "/api/admin/set-admin",
    body: z.object({ userId: uuid }).strict(),
    kind: "change",
    risk: "danger",
    auth: "admin",
    card: setAdminCard,
  },
  {
    id: "users.remove_admin",
    area: "users",
    ...where("/admin/users"),
    summary: "Remove a user's admin access (their role becomes plain user).",
    method: "POST",
    path: "/api/admin/remove-admin",
    body: z.object({ userId: uuid }).strict(),
    kind: "change",
    risk: "danger",
    auth: "admin",
    card: removeAdminCard,
  },
  {
    id: "users.remove_user",
    area: "users",
    ...where("/admin/users"),
    summary: "Permanently delete a user account and all its data, including the wallet, orders and shops.",
    method: "DELETE",
    path: "/api/admin/remove-user",
    body: z.object({ userId: uuid }).strict(),
    kind: "change",
    risk: "danger",
    auth: "admin",
    timeoutMs: 60000,
    card: removeUserCard,
  },
  {
    id: "users.change_password",
    area: "users",
    ...where("/admin/users"),
    summary: "Set a new password for a user. The password is typed into the card's secure box, never into chat.",
    method: "POST",
    path: "/api/admin/change-user-password",
    body: z.object({ userId: uuid }).strict(),
    secretFields: [{ name: "newPassword", label: "New password", min: 8, max: 128 }],
    kind: "change",
    risk: "danger",
    auth: "admin",
    card: changePasswordCard,
  },
  {
    id: "users.update_user",
    area: "users",
    ...where("/admin/users"),
    summary: "Change a user's name, sign-in email or phone number. Passwords are not changed here.",
    method: "POST",
    path: "/api/admin/users/update-user",
    body: z
      .object({
        userId: uuid,
        email: z.string().email().max(254).optional(),
        phoneNumber: z.string().regex(/^\+?[0-9 ]{7,20}$/).optional(),
        firstName: z.string().max(100).optional(),
        lastName: z.string().max(100).optional(),
      })
      .strict(),
    kind: "change",
    risk: "danger", // the sign-in email and phone decide who can take over the account and receive refunds
    auth: "admin",
    card: updateUserCard,
  },
  {
    id: "users.force_logout",
    area: "users",
    ...where("/admin/users"),
    summary: "Sign a user out of every device.",
    method: "POST",
    path: "/api/admin/users/:id/force-logout",
    params: userIdParams,
    kind: "change",
    risk: "normal",
    auth: "admin",
    card: forceLogoutCard,
  },
  {
    id: "users.password_reset",
    area: "users",
    ...where("/admin/users"),
    summary: "Email a user a password reset link.",
    method: "POST",
    path: "/api/admin/users/:id/password-reset",
    params: userIdParams,
    kind: "change",
    risk: "normal",
    auth: "admin",
    card: passwordResetCard,
  },
  {
    id: "users.phone_verified",
    area: "users",
    ...where("/admin/users"),
    summary: "Mark a user's phone number as verified or not verified.",
    method: "POST",
    path: "/api/admin/users/:id/phone-verified",
    params: userIdParams,
    body: z.object({ verified: z.boolean() }).strict(),
    kind: "change",
    risk: "money", // refunds for a phone number are paid to the account that has it verified
    auth: "admin",
    card: phoneVerifiedCard,
  },
  {
    id: "users.notes_create",
    area: "users",
    ...where("/admin/users"),
    summary: "Add an internal admin note to a user.",
    method: "POST",
    path: "/api/admin/users/:id/notes",
    params: userIdParams,
    body: z.object({ body: z.string().min(1).max(2000) }).strict(),
    kind: "change",
    risk: "normal",
    auth: "admin",
    card: noteCreateCard,
  },
  {
    id: "users.notes_update",
    area: "users",
    ...where("/admin/users"),
    summary: "Edit one of your own admin notes on a user.",
    method: "PATCH",
    path: "/api/admin/users/:id/notes/:noteId",
    params: { id: "uuid", noteId: "uuid" },
    body: z.object({ body: z.string().min(1).max(2000) }).strict(),
    kind: "change",
    risk: "normal",
    auth: "admin",
    card: noteEditCard,
  },
  {
    id: "users.notes_delete",
    area: "users",
    ...where("/admin/users"),
    summary: "Delete an admin note on a user.",
    method: "DELETE",
    path: "/api/admin/users/:id/notes/:noteId",
    params: { id: "uuid", noteId: "uuid" },
    kind: "change",
    risk: "normal",
    auth: "admin",
    card: noteDeleteCard,
  },
  {
    id: "users.tags_change",
    area: "users",
    ...where("/admin/users"),
    summary: "Add or remove admin tags on a user.",
    method: "POST",
    path: "/api/admin/users/:id/tags",
    params: userIdParams,
    body: z
      .object({
        add: z.array(z.string().regex(/^[a-z0-9-]{1,32}$/)).max(20).optional(),
        remove: z.array(z.string().regex(/^[a-z0-9-]{1,32}$/)).max(20).optional(),
      })
      .strict(),
    kind: "change",
    risk: "normal",
    auth: "admin",
    card: tagsCard,
  },
  {
    id: "users.custom_prices_set",
    area: "users",
    ...where("/admin/users"),
    summary: "Set a user's pricing mode and custom package prices (a price of null clears one).",
    method: "PUT",
    path: "/api/admin/users/:id/custom-prices",
    params: userIdParams,
    body: z
      .object({
        pricing_mode: z.enum(["role", "custom"]).optional(),
        prices: z.array(z.object({ package_id: uuid, price: z.number().positive().max(10000).nullable() }).strict()).max(200).optional(),
      })
      .strict(),
    kind: "change",
    risk: "money",
    auth: "admin",
    card: customPricesCard,
  },

  // ---- roles hub lookups ------------------------------------------------------------------------------------------
  {
    id: "roles.list",
    area: "users",
    ...where("/admin/roles"),
    summary: "The ladder of roles in rank order with member counts and how many packages each has priced.",
    method: "GET",
    path: "/api/admin/roles",
    kind: "lookup",
    risk: "normal",
    auth: "admin",
    resultKeep: [
      "package_total",
      "roles[].id",
      "roles[].slug",
      "roles[].name",
      "roles[].description",
      "roles[].rank",
      "roles[].is_system",
      "roles[].archived_at",
      "roles[].member_count",
      "roles[].priced_count",
    ],
  },
  {
    id: "roles.audit",
    area: "users",
    ...where("/admin/roles/:id"),
    summary: "The change history of one role: edits, prices, rights, rank and members moved in or out.",
    method: "GET",
    path: "/api/admin/roles/:id/audit",
    params: userIdParams,
    query: z.object({ page: z.number().int().min(1).max(200).optional() }).strict(),
    kind: "lookup",
    risk: "normal",
    auth: "admin",
    resultKeep: ["page", "has_more", "entries[].at", "entries[].actor_id", "entries[].action", "entries[].summary", "entries[].reason", "entries[].loss_override"],
  },
  {
    id: "roles.members",
    area: "users",
    ...where("/admin/roles/:id"),
    summary: "The members of one role, 50 per page, searchable by name or phone.",
    method: "GET",
    path: "/api/admin/roles/:id/members",
    params: userIdParams,
    query: z.object({ q: z.string().max(64).optional(), page: z.number().int().min(1).max(1000).optional() }).strict(),
    kind: "lookup",
    risk: "normal",
    auth: "admin",
    resultKeep: ["total", "page", "members[].id", "members[].name", "members[].phone"],
  },
  {
    id: "roles.permissions_get",
    area: "users",
    ...where("/admin/roles/:id"),
    summary: "The rights one role has, whether they can be edited, and how many members it has.",
    method: "GET",
    path: "/api/admin/roles/:id/permissions",
    params: userIdParams,
    kind: "lookup",
    risk: "normal",
    auth: "admin",
    resultKeep: ["editable", "capabilities", "member_count"],
  },
  {
    id: "roles.prices_get",
    area: "users",
    ...where("/admin/roles/:id"),
    summary: "Every package with the role's own price, the price its members actually pay, and the cost.",
    method: "GET",
    path: "/api/admin/roles/:id/prices",
    params: userIdParams,
    kind: "lookup",
    risk: "normal",
    auth: "admin",
    timeoutMs: 30000,
    resultKeep: [
      "editable",
      "packages[].id",
      "packages[].network",
      "packages[].name",
      "packages[].price",
      "packages[].cost_price",
      "packages[].role_price",
      "packages[].effective_price",
      "packages[].is_available",
    ],
  },
  {
    id: "roles.rates_get",
    area: "users",
    ...where("/admin/roles/:id"),
    summary: "The role's airtime fee and cashback share rates, own and effective.",
    method: "GET",
    path: "/api/admin/roles/:id/rates",
    params: userIdParams,
    kind: "lookup",
    risk: "normal",
    auth: "admin",
    resultKeep: ["editable", "rates[].service_key", "rates[].label", "rates[].value", "rates[].effective"],
  },

  // ---- roles hub changes ------------------------------------------------------------------------------------------
  {
    id: "roles.create",
    area: "users",
    ...where("/admin/roles"),
    summary: "Create a custom role above Dealer, optionally as a copy of an existing role.",
    method: "POST",
    path: "/api/admin/roles",
    body: z
      .object({
        slug: roleSlug,
        name: z.string().min(2).max(40),
        rank: z.number().int().min(1).max(1000000),
        clone_from: roleSlug.optional(),
        reason: roleReason,
      })
      .strict(),
    kind: "change",
    risk: "danger",
    auth: "admin",
    card: roleCreateCard,
  },
  {
    id: "roles.update",
    area: "users",
    ...where("/admin/roles/:id"),
    summary: "Edit a role's name, description, badge colour, icon or look.",
    method: "PATCH",
    path: "/api/admin/roles/:id",
    params: userIdParams,
    body: z
      .object({
        name: z.string().min(2).max(40).optional(),
        description: z.string().max(200).nullable().optional(),
        badge_color: z.enum(BADGE_COLORS).optional(),
        icon: z.enum(ROLE_ICONS).optional(),
        theme: z.object({ skin: z.enum(["default", "dealer"]) }).strict().optional(),
      })
      .strict(),
    kind: "change",
    risk: "danger",
    auth: "admin",
    card: roleUpdateCard,
  },
  {
    id: "roles.archive",
    area: "users",
    ...where("/admin/roles/:id"),
    summary: "Archive (retire) a custom role that has no members.",
    method: "POST",
    path: "/api/admin/roles/:id/archive",
    params: userIdParams,
    body: z.object({ reason: roleReason }).strict(),
    kind: "change",
    risk: "danger",
    auth: "admin",
    card: roleArchiveCard,
  },
  {
    id: "roles.move",
    area: "users",
    ...where("/admin/roles"),
    summary: "Move a custom role one step up or down the ladder by swapping places with its neighbour.",
    method: "POST",
    path: "/api/admin/roles/:id/move",
    params: userIdParams,
    body: z.object({ direction: z.enum(["up", "down"]), reason: roleReason }).strict(),
    kind: "change",
    risk: "danger",
    auth: "admin",
    card: roleMoveCard,
  },
  {
    id: "roles.members_move",
    area: "users",
    ...where("/admin/roles/:id"),
    summary: "Move several users into another role at once (admin accounts are skipped).",
    method: "POST",
    path: "/api/admin/roles/members/move",
    // The handler takes up to 200 ids and moves them one by one; 50 keeps it inside the 60 s limit.
    body: z.object({ user_ids: z.array(uuid).min(1).max(50), to_role: roleSlug.refine((s) => s !== "admin" && s !== "sub_agent", "cannot move users to that role"), reason: roleReason }).strict(),
    kind: "change",
    risk: "danger",
    auth: "admin",
    timeoutMs: 60000,
    card: membersMoveCard,
  },
  {
    id: "roles.permissions_set",
    area: "users",
    ...where("/admin/roles/:id"),
    summary: "Set exactly which rights a role has, replacing its current list.",
    method: "PUT",
    path: "/api/admin/roles/:id/permissions",
    params: userIdParams,
    body: z.object({ capabilities: z.array(z.enum([...ALL_CAPABILITIES] as [string, ...string[]])).max(30), reason: roleReason }).strict(),
    kind: "change",
    risk: "danger",
    auth: "admin",
    card: rolePermissionsCard,
  },
  {
    id: "roles.prices_set",
    area: "users",
    ...where("/admin/roles/:id"),
    summary: "Set or clear a role's package prices, with a written reason. Prices below cost need the loss override.",
    method: "PUT",
    path: "/api/admin/roles/:id/prices",
    params: userIdParams,
    body: z
      .object({
        changes: z.array(z.object({ package_id: uuid, price: z.number().positive().max(99999999.99).nullable() }).strict()).min(1).max(200),
        loss_override: z.boolean().optional(),
        reason: roleReason,
      })
      .strict(),
    kind: "change",
    risk: "danger",
    auth: "admin",
    timeoutMs: 45000,
    card: rolePricesCard,
  },
  {
    id: "roles.rates_set",
    area: "users",
    ...where("/admin/roles/:id"),
    summary: "Set or clear a custom role's airtime fee and cashback share rates.",
    method: "PUT",
    path: "/api/admin/roles/:id/rates",
    params: userIdParams,
    body: z
      .object({
        changes: z
          .array(
            z
              .object({
                service_key: z.enum(HUB_SERVICE_KEYS.map((k) => k.key) as [string, ...string[]]),
                value: z.number().min(0).max(100).nullable(),
              })
              .strict(),
          )
          .min(1)
          .max(6),
        reason: roleReason,
      })
      .strict(),
    kind: "change",
    risk: "danger",
    auth: "admin",
    card: roleRatesCard,
  },
]
