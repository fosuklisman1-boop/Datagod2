import { z } from "zod"
import type { CardCtx, CardLine, CatalogEntry, EntryInput } from "../types"
import { pageTitleFor } from "../pages"
import { calculateSegments } from "@/lib/sms/segments"
import { CATEGORY_DEFAULTS, SMS_CATEGORIES } from "@/lib/sms/categories"
import { phoneKey, localPhone, parseSinceDays, loadShopBuyerAudience } from "@/lib/sms/shop-buyers"
import { resolveRecipients } from "@/lib/sms/recipients"
import { normalizeGhanaPhone } from "@/lib/phone-format"

// Messaging group: /api/admin/ sms, sms-platform, sms-sender-ids, sms-templates, sms-groups, sms-contacts, sms-settings,
// sms-supply, sms-health, sms-opt-outs, shop-sms, broadcast, notify, whatsapp, whatsapp-inbox, support, complaints, test-email.
//
// Every route that SENDS something (broadcast, broadcast retry, notify, WhatsApp reply, takeover hand-off note, support reply,
// complaint outcome, test email, sender-ID outcome) shows the exact text that goes out, who gets it (a single recipient in
// full, or the audience definition plus a count computed with the handler's own query) and which channels carry it.
//
// Auth: the sms-platform and sms/* routes use adminGuard (verifyAdminAccess plus a real admin user), the rest verifyAdminAccess:
// all "admin". support/* and complaints use requireSupportAdmin: "support_admin". No route in this group takes a provider
// credential and none returns one.
//
// Read-marker GETs kept as lookups ON PURPOSE (an admin has to be able to read these chats): support/threads (records the admin
// as present), support/threads/:id (marks the customer's messages as delivered to an admin) and whatsapp-inbox/:phone (clears the
// unread dot). Each summary says so. Inbound customer text (chat bodies, complaint descriptions, flagged SMS bodies) is returned
// only where an admin needs it to act; never raw webhook payloads, tool context, message ids, signed document links or evidence.

type Card = { summary: string; lines: CardLine[] }
type Obj = Record<string, unknown>
type Read = { state: "found"; row: Obj } | { state: "missing" } | { state: "unread" }

const mk = (e: Omit<CatalogEntry, "area" | "pageTitle">): CatalogEntry => ({ ...e, area: "messaging", pageTitle: pageTitleFor(e.page) ?? e.page })

const SMS_CENTRE = "/admin/sms-centre"
const SMS_PLATFORM = "/admin/sms"
const SMS_HEALTH = "/admin/sms-health"
const BROADCAST = "/admin/broadcast"
const BROADCAST_HISTORY = "/admin/broadcast/history"
const COMPLAINTS = "/admin/complaints"
const WHATSAPP = "/admin/whatsapp"
const SETTINGS = "/admin/settings"

const uuid = z.string().uuid()
const bool = z.boolean()
const page = z.number().int().min(1).max(100000)
const optText = (max: number) => z.string().max(max)

const asBody = (i: EntryInput): Obj => (i.body ?? {}) as Obj
const asParams = (i: EntryInput): Record<string, string> => i.params ?? {}
const asQuery = (i: EntryInput): Obj => (i.query ?? {}) as Obj
const str = (v: unknown): string => (typeof v === "string" ? v : "")
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const onOff = (b: boolean): string => (b ? "ON" : "OFF")
const yesNo = (b: boolean): string => (b ? "yes" : "no")
const ghs = (v: unknown): string => (Number.isFinite(Number(v)) && v !== null && v !== "" ? `GHS ${Number(v).toFixed(2)}` : "unknown")
const int = (v: unknown): string => (Number.isFinite(Number(v)) ? Number(v).toLocaleString("en-US") : "unknown")
const shown = (v: unknown): string => (typeof v === "string" ? (v === "" ? "(empty)" : v) : v === null || v === undefined ? "(not set)" : typeof v === "object" ? JSON.stringify(v) : String(v))
const change = (a: string, b: string): string => `${a} -> ${b}`
const short = (id: string): string => (id ? id.slice(0, 8) : "(no id)")
const digits = (v: unknown): string => str(v).replace(/[^\d]/g, "")
const fullName = (r: Obj | null | undefined): string => [str(r?.first_name), str(r?.last_name)].filter(Boolean).join(" ")
/** Masks an EXISTING number only; a number the request will write is always shown whole. */
const maskPhone = (p: unknown): string => {
  const d = str(p)
  return d.length < 6 ? "***" : `${d.slice(0, 3)}****${d.slice(-2)}`
}

async function readOne(run: () => PromiseLike<{ data: unknown; error?: unknown }>): Promise<Read> {
  try {
    const { data, error } = await run()
    if (error) return { state: "unread" }
    if (!data || typeof data !== "object" || Array.isArray(data)) return { state: "missing" }
    return { state: "found", row: data as Obj }
  } catch {
    return { state: "unread" }
  }
}

async function readRows(run: () => PromiseLike<{ data: unknown; error?: unknown }>): Promise<Obj[] | null> {
  try {
    const { data, error } = await run()
    if (error || !Array.isArray(data)) return null
    return data as Obj[]
  } catch {
    return null
  }
}

async function readCount(run: () => PromiseLike<{ data?: unknown; count?: number | null; error?: unknown }>): Promise<number | null> {
  try {
    const { data, count, error } = await run()
    if (error) return null
    if (typeof count === "number") return count
    return Array.isArray(data) ? data.length : null
  } catch {
    return null
  }
}

const rowBy = (ctx: CardCtx, table: string, cols: string, col: string, val: string): Promise<Read> =>
  readOne(() => ctx.db.from(table).select(cols).eq(col, val).maybeSingle())

const UNREAD: CardLine = { label: "Problem", value: "The current record could not be read just now, so the old values cannot be shown." }
const UNREAD_COUNT: CardLine = { label: "Recipients", value: "could not be counted just now" }
const MISSING: CardLine = { label: "Problem", value: "No such record was found: the request will most likely be refused." }
const noteLine = (r: Read): CardLine[] => (r.state === "unread" ? [UNREAD] : r.state === "missing" ? [MISSING] : [])
const rowOf = (r: Read): Obj | null => (r.state === "found" ? r.row : null)
const problem = (value: string): CardLine => ({ label: "Problem", value })

/** The person behind an SMS account: name, email and the account's mode, status and balance. */
async function accountLines(ctx: CardCtx, accountId: string): Promise<{ lines: CardLine[]; acct: Obj | null }> {
  const a = await rowBy(ctx, "sms_accounts", "id, user_id, mode, status, unit_balance, review_hold, api_rate_limit_override", "id", accountId)
  const acct = rowOf(a)
  const lines: CardLine[] = [...noteLine(a)]
  if (acct) {
    const u = await rowBy(ctx, "users", "id, first_name, last_name, email", "id", str(acct.user_id))
    const user = rowOf(u)
    const who = user ? `${fullName(user) || "(no name)"}${user.email ? `, ${str(user.email)}` : ""}` : `user ${short(str(acct.user_id))}`
    lines.unshift({ label: "SMS account", value: `${who} (account ${short(accountId)}, ${str(acct.mode)} mode, ${str(acct.status)}, ${int(acct.unit_balance)} credits)` })
  } else lines.unshift({ label: "SMS account", value: `id ${accountId}` })
  return { lines, acct }
}

const providerLabel = (p: string): string => (p === "moolre" ? "Moolre" : p === "mnotify" ? "mNotify" : p === "both" ? "both Moolre and mNotify" : p)

// ---------------------------------------------------------------------------------------------------------------------
// Address book (groups, contacts, templates, opt-outs)
// ---------------------------------------------------------------------------------------------------------------------

async function groupLine(ctx: CardCtx, groupId: string): Promise<{ lines: CardLine[]; row: Obj | null }> {
  const r = await readOne(() => ctx.db.from("sms_groups").select("id, name, description, sms_account_id").eq("id", groupId).is("sms_account_id", null).maybeSingle())
  const row = rowOf(r)
  return { lines: [{ label: "Group", value: row ? `${shown(row.name)} (${short(groupId)})` : `id ${groupId}` }, ...noteLine(r)], row }
}

const groupCreateCard = async (i: EntryInput): Promise<Card> => {
  const b = asBody(i)
  return { summary: "Create an SMS address-book group", lines: [{ label: "Name", value: str(b.name) }, { label: "Description", value: shown(b.description) }, { label: "Effect", value: "A new empty group is added to the SMS address book. Nothing is sent." }] }
}

const groupUpdateCard = async (i: EntryInput, ctx: CardCtx): Promise<Card> => {
  const b = asBody(i)
  const { lines, row } = await groupLine(ctx, asParams(i).id ?? "")
  if (b.name !== undefined) lines.push({ label: "Name", value: change(shown(row?.name), str(b.name)) })
  if (b.description !== undefined) lines.push({ label: "Description", value: change(shown(row?.description), shown(b.description)) })
  if (b.name === undefined && b.description === undefined) lines.push(problem("Neither a name nor a description was given: nothing changes."))
  return { summary: "Rename or re-describe an SMS group", lines }
}

const groupDeleteCard = async (i: EntryInput, ctx: CardCtx): Promise<Card> => {
  const id = asParams(i).id ?? ""
  const { lines } = await groupLine(ctx, id)
  const n = await readCount(() => ctx.db.from("sms_contacts").select("id", { count: "exact", head: true }).eq("group_id", id))
  lines.push({ label: "Contacts deleted with it", value: n === null ? "unknown (could not be counted)" : String(n) })
  lines.push({ label: "Effect", value: "The group and every contact in it are deleted for good. Nothing is sent. A broadcast aimed at this group can no longer be started." })
  return { summary: "Delete an SMS group and all its contacts", lines }
}

const contactAddCard = async (i: EntryInput, ctx: CardCtx): Promise<Card> => {
  const b = asBody(i)
  const { lines } = await groupLine(ctx, str(b.group_id))
  if (Array.isArray(b.rows)) {
    const rows = b.rows as Obj[]
    const seen = new Set<string>()
    let invalid = 0
    let dup = 0
    for (const r of rows) {
      const p = normalizeGhanaPhone(str(r.phone_number))
      if (!p) invalid++
      else if (seen.has(p)) dup++
      else seen.add(p)
    }
    lines.push({ label: "Rows sent", value: String(rows.length) })
    lines.push({ label: "Will be added", value: `${seen.size} numbers (${invalid} not valid Ghana numbers and ${dup} repeated within the list are skipped; numbers already in the group are skipped too)` })
    const list = [...seen]
    lines.push({ label: "Numbers", value: list.slice(0, 25).join(", ") + (list.length > 25 ? `, and ${list.length - 25} more` : "") })
    return { summary: `Import ${rows.length} contacts into an SMS group`, lines }
  }
  const raw = str(b.phone_number)
  const phone = normalizeGhanaPhone(raw)
  lines.push({ label: "Number", value: phone ? `${phone}${phone !== raw ? ` (typed as ${raw})` : ""}` : `${raw || "(none)"}: not a valid Ghana number, the request will be refused` })
  lines.push({ label: "Name", value: fullName(b) || "(none)" })
  lines.push({ label: "Effect", value: "One contact is added to the group. Nothing is sent." })
  return { summary: "Add a contact to an SMS group", lines }
}

async function contactLines(ctx: CardCtx, id: string): Promise<{ lines: CardLine[]; row: Obj | null }> {
  const r = await rowBy(ctx, "sms_contacts", "id, group_id, phone_number, first_name, last_name, opted_out", "id", id)
  const row = rowOf(r)
  const lines: CardLine[] = [{ label: "Contact", value: row ? `${fullName(row) || "(no name)"}, ${maskPhone(row.phone_number)}, ${row.opted_out ? "opted out" : "not opted out"} now` : `id ${id}` }, ...noteLine(r)]
  return { lines, row }
}

const contactOptCard = async (i: EntryInput, ctx: CardCtx): Promise<Card> => {
  const b = asBody(i)
  const { lines } = await contactLines(ctx, asParams(i).id ?? "")
  lines.push({ label: "Opted out", value: b.opted_out === true ? "no -> yes: the contact is skipped by every group broadcast from now on" : "yes -> no: the contact receives group broadcasts again" })
  return { summary: "Change a contact's opt-out", lines }
}

const contactDeleteCard = async (i: EntryInput, ctx: CardCtx): Promise<Card> => {
  const { lines } = await contactLines(ctx, asParams(i).id ?? "")
  lines.push({ label: "Effect", value: "The contact is removed from its group for good. Nothing is sent." })
  return { summary: "Delete an SMS contact", lines }
}

const templateCreateCard = async (i: EntryInput): Promise<Card> => {
  const b = asBody(i)
  return { summary: "Save an SMS template", lines: [{ label: "Name", value: str(b.name) }, { label: "Template text", value: str(b.body) }, { label: "Effect", value: "The template is saved for later use. Nothing is sent." }] }
}

const templateUpdateCard = async (i: EntryInput, ctx: CardCtx): Promise<Card> => {
  const b = asBody(i)
  const id = asParams(i).id ?? ""
  const r = await rowBy(ctx, "sms_templates", "id, name, body", "id", id)
  const row = rowOf(r)
  const lines: CardLine[] = [{ label: "Template", value: row ? `${shown(row.name)} (${short(id)})` : `id ${id}` }, ...noteLine(r)]
  if (b.name !== undefined) lines.push({ label: "Name", value: change(shown(row?.name), str(b.name)) })
  if (b.body !== undefined) lines.push({ label: "Template text", value: change(shown(row?.body), str(b.body)) })
  if (b.name === undefined && b.body === undefined) lines.push(problem("Neither a name nor a text was given: nothing changes."))
  return { summary: "Edit an SMS template", lines }
}

const templateDeleteCard = async (i: EntryInput, ctx: CardCtx): Promise<Card> => {
  const id = asParams(i).id ?? ""
  const r = await rowBy(ctx, "sms_templates", "id, name, body", "id", id)
  const row = rowOf(r)
  return { summary: "Delete an SMS template", lines: [{ label: "Template", value: row ? `${shown(row.name)}: ${shown(row.body)}` : `id ${id}` }, ...noteLine(r), { label: "Effect", value: "The template is deleted for good. Nothing is sent." }] }
}

/** Same parsing as POST and DELETE /api/admin/sms-opt-outs: commas, semicolons and new lines separate numbers; a piece with more digits than one number holds is split on spaces. */
function parseOptOutPhones(input: unknown): { keys: string[]; invalid: string[] } {
  const pieces = Array.isArray(input) ? input.map(String) : String(input ?? "").split(/[,;\r\n]+/)
  const raw = pieces.flatMap((p) => (p.replace(/\D/g, "").length > 13 ? p.split(/\s+/) : [p]))
  const keys = new Set<string>()
  const invalid: string[] = []
  for (const p of raw.map((s) => s.trim()).filter(Boolean)) {
    const k = phoneKey(p)
    if (k) keys.add(k)
    else invalid.push(p)
  }
  return { keys: [...keys], invalid }
}

const numbersLine = (keys: string[]): CardLine => ({ label: "Numbers", value: keys.map(localPhone).slice(0, 40).join(", ") + (keys.length > 40 ? `, and ${keys.length - 40} more` : "") })

const optOutAddCard = async (i: EntryInput): Promise<Card> => {
  const b = asBody(i)
  const { keys, invalid } = parseOptOutPhones(b.phones)
  const lines: CardLine[] = [{ label: "Numbers added", value: String(keys.length) }, numbersLine(keys)]
  if (invalid.length) lines.push({ label: "Not valid", value: `${invalid.length}: ${invalid.slice(0, 10).join(", ")}` })
  if (keys.length === 0) lines.push(problem("No valid Ghana mobile numbers: the request will be refused."))
  if (keys.length > 5000) lines.push(problem("More than 5,000 numbers: the request will be refused."))
  lines.push({ label: "Reason kept", value: typeof b.reason === "string" && b.reason.trim() ? b.reason.trim().slice(0, 200) : "(none)" })
  lines.push({ label: "Effect", value: "These numbers are never sent marketing SMS again (group and shop-buyer broadcasts skip them). Nothing is sent now." })
  return { summary: "Add numbers to the marketing SMS do-not-text list", lines }
}

const optOutRemoveCard = async (i: EntryInput): Promise<Card> => {
  const { keys } = parseOptOutPhones(asBody(i).phones)
  const lines: CardLine[] = [{ label: "Numbers removed", value: String(keys.length) }, numbersLine(keys)]
  if (keys.length === 0) lines.push(problem("No valid numbers: the request will be refused."))
  lines.push({ label: "Effect", value: "These numbers can receive marketing SMS again. People who asked to stop will be texted by the next broadcast that includes them. Nothing is sent now." })
  return { summary: "Remove numbers from the marketing SMS do-not-text list", lines }
}

// ---------------------------------------------------------------------------------------------------------------------
// Sender IDs (admin-global list and the SMS-platform review)
// ---------------------------------------------------------------------------------------------------------------------

const SENDER_COLS = "id, sender_id, local_status, mnotify_local_status, sms_account_id"

async function senderLines(ctx: CardCtx, id: string): Promise<{ lines: CardLine[]; row: Obj | null }> {
  const r = await rowBy(ctx, "sms_sender_ids", SENDER_COLS, "id", id)
  const row = rowOf(r)
  const lines: CardLine[] = [{ label: "Sender ID", value: row ? `${shown(row.sender_id)} (${short(id)}), Moolre status ${shown(row.local_status)}, mNotify status ${shown(row.mnotify_local_status)}` : `id ${id}` }, ...noteLine(r)]
  if (row?.sms_account_id) lines.push(...(await accountLines(ctx, str(row.sms_account_id))).lines.map((l) => (l.label === "SMS account" ? { label: "Requested by", value: l.value } : l)))
  else if (row) lines.push({ label: "Owner", value: "The platform itself (not a customer's request)" })
  return { lines, row }
}

const senderSubmitCard = async (i: EntryInput): Promise<Card> => ({
  summary: "Add a platform sender ID (pending)",
  lines: [{ label: "Sender ID", value: str(asBody(i).sender_id).trim().toUpperCase() }, { label: "Effect", value: "A pending sender ID is saved (shown in capitals). No provider is contacted and nothing is sent; pushing it to a provider is a separate step." }],
})

const senderApproveCard = async (i: EntryInput, ctx: CardCtx): Promise<Card> => {
  const b = asBody(i)
  const { lines, row } = await senderLines(ctx, str(b.id))
  if (row?.sms_account_id) {
    lines.push({ label: "What changes", value: "This is a customer's request, so it is approved by the platform's own rules (the provider choice is ignored): it becomes active and can become that customer's default sender. Only a pending request can be approved, and a Platform-mode account may only have one sender ID." })
    lines.push({ label: "Notices", value: "The customer is notified that the request was approved." })
  } else {
    lines.push({ label: "What changes", value: `The sender ID is marked approved for ${providerLabel(str(b.provider))} by hand. No provider is contacted.` })
    lines.push({ label: "Notices", value: "Nobody is notified (platform-owned sender ID)." })
  }
  return { summary: "Approve a sender ID", lines }
}

const senderRejectCard = async (i: EntryInput, ctx: CardCtx): Promise<Card> => {
  const b = asBody(i)
  const { lines, row } = await senderLines(ctx, str(b.id))
  if (row?.sms_account_id) {
    lines.push({ label: "Reason given to the customer", value: str(b.reason).trim() || "Rejected by admin" })
    lines.push({ label: "What changes", value: "The pending request is marked rejected with this reason (the provider choice is ignored)." })
    lines.push({ label: "Notices", value: "The customer is notified that the request was rejected, with the reason." })
  } else {
    lines.push({ label: "What changes", value: `The sender ID is marked rejected for ${providerLabel(str(b.provider))} by hand. No provider is contacted; any reason given is not stored for platform-owned IDs.` })
    lines.push({ label: "Notices", value: "Nobody is notified (platform-owned sender ID)." })
  }
  return { summary: "Reject a sender ID", lines }
}

const senderProviderCard = (what: string, effect: (p: string) => string) => async (i: EntryInput, ctx: CardCtx): Promise<Card> => {
  const b = asBody(i)
  const { lines } = await senderLines(ctx, str(b.id))
  lines.push({ label: "Provider", value: providerLabel(str(b.provider)) })
  lines.push({ label: "What happens", value: effect(providerLabel(str(b.provider))) })
  return { summary: what, lines }
}

const senderPollCard = async (): Promise<Card> => ({
  summary: "Check every pending platform sender ID with the providers",
  lines: [{ label: "What happens", value: "Each platform-owned sender ID that is still pending and was already pushed is checked with Moolre and with mNotify, and its status is updated. Customers' own requests are not touched. No message is sent." }],
})

const senderPlatformActionCard = async (i: EntryInput, ctx: CardCtx): Promise<Card> => {
  const b = asBody(i)
  const { lines } = await senderLines(ctx, asParams(i).id ?? "")
  const action = str(b.action)
  const reason = str(b.reason).trim()
  lines.push({ label: "Action", value: action })
  if (action === "approve") {
    lines.push({ label: "What changes", value: "The pending request becomes active (and the customer's default sender if they have none). Needs Hubtel to be the active provider, and a Platform-mode account may only have one sender ID." })
  } else if (action === "reject") {
    lines.push({ label: "Reason", value: reason || "(missing: a reason of at least 3 characters is required, the request will be refused)" })
    lines.push({ label: "What changes", value: "The pending request is marked rejected with this reason." })
  } else {
    lines.push({ label: "Reason", value: reason || "(none)" })
    lines.push({ label: "What changes", value: "An active or paused sender ID is revoked for good; any account using it as default falls back to the platform sender." })
  }
  lines.push({ label: "Notices", value: "This route sends the customer no notice." })
  return { summary: `${action[0]?.toUpperCase() ?? ""}${action.slice(1)} a customer's sender ID`, lines }
}

// ---------------------------------------------------------------------------------------------------------------------
// Provider routing and SMS platform settings
// ---------------------------------------------------------------------------------------------------------------------

async function settingRows(ctx: CardCtx, table: "admin_settings" | "tenant_global_settings", keys: string[]): Promise<Map<string, unknown> | null> {
  const rows = await readRows(() => ctx.db.from(table).select("key, value").in("key", keys))
  if (!rows) return null
  return new Map(rows.map((r) => [str(r.key), r.value]))
}

const routingCard = async (i: EntryInput, ctx: CardCtx): Promise<Card> => {
  const b = asBody(i)
  const stored = await settingRows(ctx, "admin_settings", ["sms_primary_provider", "sms_fallback_providers", "sms_category_providers", "sms_tenant_provider_choice_enabled"])
  const lines: CardLine[] = []
  if (!stored) lines.push(UNREAD)
  const list = (v: unknown): string => (Array.isArray(v) ? v.join(", ") || "(none)" : shown(v))
  if (b.primary !== undefined) lines.push({ label: "Primary provider", value: change(stored ? shown(stored.get("sms_primary_provider")) : "unknown", str(b.primary)) })
  if (b.fallbacks !== undefined) lines.push({ label: "Fallback providers", value: change(stored ? list(stored.get("sms_fallback_providers")) : "unknown", list(b.fallbacks)) })
  if (b.categoryProviders && typeof b.categoryProviders === "object") {
    const cur = (stored?.get("sms_category_providers") ?? {}) as Obj
    for (const [k, v] of Object.entries(b.categoryProviders as Obj)) {
      const was = typeof cur[k] === "string" ? str(cur[k]) : (CATEGORY_DEFAULTS as Record<string, string>)[k] ?? "global"
      lines.push({ label: `Provider for ${k} messages`, value: change(was, str(v)) })
    }
  }
  if (b.tenantProviderChoice !== undefined) {
    const was = stored ? (stored.get("sms_tenant_provider_choice_enabled") === true || stored.get("sms_tenant_provider_choice_enabled") === "true" ? "on" : "off") : "unknown"
    lines.push({ label: "Customers may pick their own provider", value: change(was, b.tenantProviderChoice === true ? "on" : "off") })
  }
  if (lines.every((l) => l === UNREAD)) lines.push(problem("No setting was given: nothing changes."))
  lines.push({ label: "Effect", value: "Every SMS the platform sends (OTP codes, order confirmations, alerts, broadcasts) follows this routing from now on. Hubtel can only be made primary while a Hubtel balance can be read (live relay or the manual balance), otherwise the request is refused." })
  return { summary: "Change the SMS provider routing", lines }
}

const SECTION_KEYS: Record<string, string[]> = {
  switch: ["sms_feature_enabled"],
  caps: ["sms_caps"],
  moderation: ["sms_auto_suspend_flags", "sms_flag_review_threshold"],
  api_limit: ["sms_api_rate_limit_default"],
  roles: ["sms_allowed_roles"],
  sender_pool: ["sms_sender_pool"],
  platform_senders: ["sms_platform_senders", "sms_platform_default_sender"],
  platform_keywords: ["sms_blocked_keywords"],
  business_lists: ["sms_business_blocked_keywords", "sms_business_flagged_keywords", "sms_business_allowed_domains"],
  pricing: ["sms_activation_fee", "sms_welcome_bonus_credits", "sms_price_per_credit"],
  hubtel: ["sms_hubtel_cost_per_sms", "sms_hubtel_low_balance_ghs"],
  hubtel_manual_balance: ["sms_hubtel_manual_balance", "sms_hubtel_prefer_manual_balance"],
}
const SECTION_FIELDS: Record<string, string[]> = {
  switch: ["featureEnabled"],
  caps: ["platform", "business"],
  moderation: ["autoSuspendFlags", "flagReviewThreshold"],
  api_limit: ["apiRateLimitDefault"],
  roles: ["allowedRoles"],
  sender_pool: ["senderPool"],
  platform_senders: ["platformSenders"],
  platform_keywords: ["blockedKeywords"],
  business_lists: ["businessBlockedKeywords", "businessFlaggedKeywords", "businessAllowedDomains"],
  pricing: ["activationFee", "welcomeBonusCredits", "pricePerCredit"],
  hubtel: ["hubtelCostPerSms", "hubtelLowBalanceGhs"],
}
const SECTION_NOTE: Record<string, string> = {
  switch: "Turns the whole SMS product on or off for every customer.",
  caps: "Sets how many recipients one send, one hour and one day may carry, per mode.",
  moderation: "Sets when flags suspend an account or put it under review.",
  api_limit: "Sets the default API rate limit for every account without its own override.",
  roles: "Sets which kinds of user may use the SMS product.",
  sender_pool: "Replaces the pool of sender names.",
  platform_senders: "Replaces the platform sender names and the default one.",
  platform_keywords: "Replaces the blocked keywords for platform-mode sends.",
  business_lists: "Replaces the blocked keywords, flagged keywords and allowed link domains for business-mode sends.",
  pricing: "Changes what customers pay: the activation fee, the welcome bonus and the price per credit.",
  hubtel: "Changes the Hubtel cost per SMS and the low-balance alert level.",
  hubtel_manual_balance: "Sets the manual Hubtel balance (used when the live reading fails, or preferred over it) and its preference switch. This number decides how many credits can be sold or allocated.",
}

const platformSettingsCard = async (i: EntryInput, ctx: CardCtx): Promise<Card> => {
  const b = asBody(i)
  const section = str(b.section)
  const values = (b.values && typeof b.values === "object" ? b.values : {}) as Obj
  const lines: CardLine[] = [{ label: "Section", value: section }]
  const missing = (SECTION_FIELDS[section] ?? []).filter((f) => values[f] === undefined)
  if (section === "hubtel_manual_balance" && values.amountGhs === undefined && values.preferManual === undefined) missing.push("amountGhs or preferManual")
  if (missing.length) lines.push(problem(`Missing ${missing.join(", ")}: the request will be refused.`))
  for (const [k, v] of Object.entries(values)) lines.push({ label: k, value: typeof v === "string" ? v : JSON.stringify(v) })
  const keys = SECTION_KEYS[section] ?? []
  const stored = keys.length ? await settingRows(ctx, "tenant_global_settings", keys) : new Map<string, unknown>()
  if (!stored) lines.push(UNREAD)
  else for (const k of keys) lines.push({ label: "Stored now", value: `${k} = ${stored.has(k) ? JSON.stringify(stored.get(k)) : "(not set)"}` })
  lines.push({ label: "Effect", value: SECTION_NOTE[section] ?? "Changes an SMS platform setting." })
  return { summary: `Change the SMS platform settings: ${section}`, lines }
}

const shopSmsSettingsCard = async (i: EntryInput, ctx: CardCtx): Promise<Card> => {
  const b = asBody(i)
  const keys = Object.keys(b)
  const stored = keys.length ? await settingRows(ctx, "tenant_global_settings", keys) : new Map<string, unknown>()
  const lines: CardLine[] = []
  if (!stored) lines.push(UNREAD)
  for (const k of keys) lines.push({ label: k, value: change(stored ? (stored.has(k) ? JSON.stringify(stored.get(k)) : "(not set)") : "unknown", JSON.stringify(b[k])) })
  if (keys.length === 0) lines.push(problem("No setting was given: the request will be refused."))
  lines.push({ label: "Effect", value: "The value is written exactly as given into the metered SMS settings (fees, welcome bonus, price per credit, blocked keywords, allowed link domains, the on/off switch). The on/off switch stops or starts the SMS product for everyone." })
  return { summary: "Change the metered SMS settings", lines }
}

const shopSmsActionCard = async (i: EntryInput, ctx: CardCtx): Promise<Card> => {
  const b = asBody(i)
  if (b.action === "set_suspended") {
    const { lines } = await accountLines(ctx, str(b.accountId))
    lines.push({ label: "Action", value: b.suspended === true ? "SUSPEND the account: it can no longer send SMS" : "UNSUSPEND the account: it can send SMS again" })
    return { summary: b.suspended === true ? "Suspend an SMS account" : "Unsuspend an SMS account", lines }
  }
  const logId = str(b.logId)
  const r = await rowBy(ctx, "sms_send_logs", "id, sms_account_id, flagged, flag_reason", "id", logId)
  const row = rowOf(r)
  const lines: CardLine[] = [{ label: "Flagged send", value: row ? `log ${short(logId)}, reason ${shown(row.flag_reason)}` : `log ${logId || "(none: a log id is required)"}` }, ...noteLine(r)]
  lines.push({ label: "Effect", value: "The flag on this send is cleared. Nothing is sent and the account is not changed." })
  return { summary: "Dismiss a flagged SMS send", lines }
}

const platformAccountCard = async (i: EntryInput, ctx: CardCtx): Promise<Card> => {
  const b = asBody(i)
  const { lines, acct } = await accountLines(ctx, asParams(i).id ?? "")
  if (b.mode !== undefined) {
    lines.push({ label: "Mode", value: change(shown(acct?.mode), str(b.mode)) })
    lines.push({ label: "Mode side effects", value: b.mode === "platform" ? "Extra sender IDs are paused and the default sender is repointed." : "Paused sender IDs are unpaused one by one." })
  }
  if (b.api_rate_limit_override !== undefined) lines.push({ label: "API rate limit override", value: change(acct ? (acct.api_rate_limit_override === null ? "default" : shown(acct.api_rate_limit_override)) : "unknown", b.api_rate_limit_override === null ? "default" : shown(b.api_rate_limit_override)) })
  if (b.review_hold !== undefined) {
    lines.push({ label: "Review hold", value: change(acct ? yesNo(acct.review_hold === true) : "unknown", yesNo(b.review_hold === true)) })
    lines.push({ label: "Hold side effects", value: b.review_hold === true ? "Every new send of this account is held for review." : "Held sends are no longer held, and the account's open info flags are dismissed." })
  }
  if (b.mode === undefined && b.api_rate_limit_override === undefined && b.review_hold === undefined) lines.push(problem("Nothing to update: the request will be refused."))
  return { summary: "Change an SMS account's mode, rate limit or review hold", lines }
}

const businessReviewCard = async (i: EntryInput, ctx: CardCtx): Promise<Card> => {
  const b = asBody(i)
  const id = asParams(i).id ?? ""
  const r = await rowBy(ctx, "sms_business_profiles", "id, sms_account_id, business_name, status", "id", id)
  const row = rowOf(r)
  const lines: CardLine[] = [{ label: "Application", value: row ? `${shown(row.business_name)} (${short(id)}), status ${shown(row.status)}` : `id ${id}` }, ...noteLine(r)]
  if (row?.sms_account_id) lines.push(...(await accountLines(ctx, str(row.sms_account_id))).lines)
  const action = str(b.action)
  if (action === "approve") {
    lines.push({ label: "What changes", value: "The application is approved and the account is switched to Business mode (its paused sender IDs are unpaused). Identity documents are scheduled for deletion." })
    lines.push({ label: "Notices", value: "The owner is notified in the app that the business is verified. If the mode switch fails the approval still stands and the request reports it." })
  } else if (action === "reject") {
    const reason = str(b.reason).trim()
    lines.push({ label: "Reason given to the owner", value: reason || "(missing)" })
    if (reason.length < 5) lines.push(problem("A rejection reason of at least 5 characters is required: the request will be refused."))
    lines.push({ label: "What changes", value: "The application is marked rejected and the owner may fix it and submit again. Identity documents are scheduled for deletion." })
    lines.push({ label: "Notices", value: `The owner is notified in the app: "Business verification not approved. Reason: ${reason}".` })
  } else {
    lines.push({ label: "What changes", value: "Only for an already approved application: the switch to Business mode is run again (and still-paused sender IDs are unpaused)." })
    lines.push({ label: "Notices", value: "The owner is notified in the app that the business is verified." })
  }
  return { summary: `${action === "approve" ? "Approve" : action === "reject" ? "Reject" : "Retry the mode switch for"} a business verification`, lines }
}

const flagActionCard = async (i: EntryInput, ctx: CardCtx): Promise<Card> => {
  const b = asBody(i)
  const id = asParams(i).id ?? ""
  const lines: CardLine[] = [{ label: "Flag", value: `${str(b.source)} flag ${short(id)}` }]
  if (b.source === "flag") {
    const f = await rowBy(ctx, "sms_flags", "id, sms_account_id, status", "id", id)
    const row = rowOf(f)
    if (row?.sms_account_id) lines.push(...(await accountLines(ctx, str(row.sms_account_id))).lines)
    else lines.push(...noteLine(f))
  }
  if (b.action === "suspend") {
    lines.push({ label: "What changes", value: "The SMS account behind this flag is suspended (it can no longer send) and the flag is marked actioned." })
  } else {
    lines.push({ label: "What changes", value: "The flag is dismissed. The account is not changed." })
  }
  return { summary: b.action === "suspend" ? "Suspend the SMS account behind a flag" : "Dismiss an SMS flag", lines }
}

// ---------------------------------------------------------------------------------------------------------------------
// SMS bundles, credits
// ---------------------------------------------------------------------------------------------------------------------

const BUNDLE_COLS = "id, name, units, price_ghs, active, mode, owner_type_scope, sort_order"

const bundleCreateCard = async (i: EntryInput): Promise<Card> => {
  const b = asBody(i)
  return {
    summary: "Create an SMS bundle",
    lines: [
      { label: "Name", value: str(b.name) },
      { label: "Credits", value: int(b.units) },
      { label: "Price", value: ghs(b.price_ghs) },
      { label: "Mode", value: str(b.mode) || "platform" },
      { label: "Who can buy it", value: str(b.owner_type_scope) || "all" },
      { label: "Effect", value: "A new bundle appears for customers to buy at this price. Nobody is charged and nothing is sent now." },
    ],
  }
}

const bundleUpdateCard = async (i: EntryInput, ctx: CardCtx): Promise<Card> => {
  const b = asBody(i)
  const id = str(b.id)
  const r = await rowBy(ctx, "sms_bundles", BUNDLE_COLS, "id", id)
  const row = rowOf(r)
  const lines: CardLine[] = [{ label: "Bundle", value: row ? `${shown(row.name)} (${short(id)})` : `id ${id}` }, ...noteLine(r)]
  if (b.name !== undefined) lines.push({ label: "Name", value: change(shown(row?.name), str(b.name)) })
  if (b.units !== undefined) lines.push({ label: "Credits", value: change(row ? int(row.units) : "unknown", int(b.units)) })
  if (b.price_ghs !== undefined) lines.push({ label: "Price", value: change(row ? ghs(row.price_ghs) : "unknown", ghs(b.price_ghs)) })
  if (b.active !== undefined) lines.push({ label: "Active", value: change(row ? yesNo(row.active === true) : "unknown", yesNo(b.active === true)) })
  if (b.mode !== undefined) lines.push({ label: "Mode", value: change(shown(row?.mode), str(b.mode)) })
  if (b.owner_type_scope !== undefined) lines.push({ label: "Who can buy it", value: change(shown(row?.owner_type_scope), str(b.owner_type_scope)) })
  if (b.sort_order !== undefined) lines.push({ label: "Sort order", value: change(shown(row?.sort_order), shown(b.sort_order)) })
  lines.push({ label: "Effect", value: "The bundle changes for customers straight away (what they pay and get, or whether it is offered). Nobody is charged and nothing is sent." })
  return { summary: "Edit an SMS bundle", lines }
}

const bundleDeleteCard = async (i: EntryInput, ctx: CardCtx): Promise<Card> => {
  const id = str(asQuery(i).id)
  const r = await rowBy(ctx, "sms_bundles", BUNDLE_COLS, "id", id)
  const row = rowOf(r)
  return {
    summary: "Delete an SMS bundle",
    lines: [
      { label: "Bundle", value: row ? `${shown(row.name)}, ${int(row.units)} credits for ${ghs(row.price_ghs)}, ${row.active ? "ACTIVE (refused: it must be switched off first)" : "inactive"}` : `id ${id}` },
      ...noteLine(r),
      { label: "Effect", value: "Only a bundle that has been inactive for at least 48 hours is deleted, and for good." },
    ],
  }
}

const allocateCard = async (i: EntryInput, ctx: CardCtx): Promise<Card> => {
  const b = asBody(i)
  const { lines, acct } = await accountLines(ctx, str(b.accountId))
  const units = Number(b.units)
  lines.push({ label: "Credits to add", value: `${int(units)} free SMS credits (no payment is taken)` })
  if (acct && Number.isFinite(units)) lines.push({ label: "Balance", value: `${change(`${int(acct.unit_balance)} credits`, `${int(Number(acct.unit_balance) + units)} credits`)} if credited now` })
  lines.push({ label: "Backing", value: "Credits are only added when the wholesale balance backs them; otherwise they are held as pending and added later." })
  lines.push({ label: "Request id", value: b.requestId ? `${str(b.requestId)} (a repeat of this request credits nothing a second time)` : "none given: if this request is repeated the credits are added twice" })
  return { summary: "Give an SMS account free credits", lines }
}

// ---------------------------------------------------------------------------------------------------------------------
// Broadcast, retry, notify, test email
// ---------------------------------------------------------------------------------------------------------------------

const CHANNEL_LABEL: Record<string, string> = { sms: "SMS", email: "Email", push: "Push notification", whatsapp: "WhatsApp" }
const RECIPIENTS_MAX = 100_000 // BROADCAST_LIMITS.recipientsMax
const FIRST_BATCH = 30 // BROADCAST_LIMITS.firstBatch
const PAGE = 1000
const MAX_PAGES = 120

type Person = { id?: string; email?: string; phone?: string; name?: string }
type Audience = { lines: CardLine[]; count: number | null; withPhone?: number; withEmail?: number }

// Same key the queue uses to de-duplicate a broadcast: user id, else phone, else email.
const personKey = (p: Person): string => p.id || p.phone || p.email || ""
function dedupePeople(list: Person[]): Person[] {
  const seen = new Set<string>()
  const out: Person[] = []
  for (const p of list) {
    const k = personKey(p)
    if (k && seen.has(k)) continue
    if (k) seen.add(k)
    out.push(p)
  }
  return out
}

const peopleStats = (list: Person[]): Pick<Audience, "withPhone" | "withEmail"> => ({
  withPhone: list.filter((p) => !!p.phone).length,
  withEmail: list.filter((p) => !!p.email).length,
})

async function broadcastAudience(b: Obj, ctx: CardCtx): Promise<Audience> {
  const rec = (b.recipients ?? {}) as Obj
  const type = str(rec.type)
  if (type === "roles") {
    const roles = arr(rec.roles).map(String)
    const people: Person[] = []
    try {
      for (let p = 0; p < MAX_PAGES; p++) {
        const { data, error } = await ctx.db.from("users").select("id, email, phone_number, first_name, role").in("role", roles).order("id", { ascending: true }).range(p * PAGE, (p + 1) * PAGE - 1)
        if (error) throw error
        for (const u of (data ?? []) as Obj[]) people.push({ id: str(u.id), email: str(u.email) || undefined, phone: str(u.phone_number) || undefined })
        if (!data || data.length < PAGE) break
      }
    } catch {
      return { lines: [{ label: "Audience", value: `Every user with the role ${roles.join(" or ")}` }], count: null }
    }
    const list = dedupePeople(people)
    return { lines: [{ label: "Audience", value: `Every user with the role ${roles.join(" or ")}` }], count: list.length, ...peopleStats(list) }
  }
  if (type === "shop_owners") {
    const people: Person[] = []
    try {
      for (let p = 0; p < MAX_PAGES; p++) {
        const { data, error } = await ctx.db.from("user_shops").select("id, users(id, email, phone_number, first_name)").not("user_id", "is", null).order("id", { ascending: true }).range(p * PAGE, (p + 1) * PAGE - 1)
        if (error) throw error
        for (const row of (data ?? []) as unknown as Obj[]) {
          const u = row.users as Obj | null
          if (u?.id) people.push({ id: str(u.id), email: str(u.email) || undefined, phone: str(u.phone_number) || undefined })
        }
        if (!data || data.length < PAGE) break
      }
    } catch {
      return { lines: [{ label: "Audience", value: "Every shop owner (dealers and sub-agents)" }], count: null }
    }
    const list = dedupePeople(people)
    return { lines: [{ label: "Audience", value: "Every shop owner (dealers and sub-agents)" }], count: list.length, ...peopleStats(list) }
  }
  if (type === "group") {
    const g = await groupLine(ctx, str(rec.groupId))
    const named = g.lines.map((l) => (l.label === "Group" ? { label: "Audience", value: `Address-book group ${l.value}` } : l))
    try {
      // The handler's own resolver: invalid numbers, opted-out contacts and repeats are dropped exactly as at send time.
      const res = await resolveRecipients({ type: "group", groupId: str(rec.groupId) }, ctx.db)
      const by = (reason: string) => res.skipped.filter((s) => s.reason === reason).length
      return { lines: [...named, { label: "Skipped", value: `${by("invalid_phone")} not valid numbers, ${by("opted_out")} opted out, ${by("duplicate")} repeated` }], count: res.contacts.length, withPhone: res.contacts.length }
    } catch {
      return { lines: named, count: null }
    }
  }
  if (type === "shop_buyers") {
    const since = parseSinceDays(rec.sinceDays)
    const ids = rec.shopIds === "all" ? "all" : arr(rec.shopIds).map(String)
    const scope = `Customers who paid for, or received, a data order from ${ids === "all" ? "any shop" : `${ids.length} chosen shop(s)`}${since === null || since === "invalid" ? ", all time" : `, in the last ${since} days`}`
    try {
      let audience = await loadShopBuyerAudience(ctx.db, { shopIds: ids, sinceDays: since === "invalid" ? null : since })
      if (str(b.message).includes("[ShopCode]")) audience = audience.filter(({ shop }) => !!shop.code)
      const shops = new Set(audience.map((a) => a.shop.id))
      return { lines: [{ label: "Audience", value: scope }, { label: "Shops reached", value: String(shops.size) }], count: audience.length, withPhone: audience.length }
    } catch {
      return { lines: [{ label: "Audience", value: scope }], count: null }
    }
  }
  const list = dedupePeople(arr(rec.users) as Person[])
  const each = list.slice(0, 25).map((p) => [p.name, p.phone, p.email, p.id ? `id ${short(p.id)}` : ""].filter(Boolean).join(" "))
  return {
    lines: [{ label: "Audience", value: "The people listed" }, { label: "People", value: each.join("; ") + (list.length > 25 ? `; and ${list.length - 25} more` : "") }],
    count: list.length,
    ...peopleStats(list),
  }
}

const smsPartsLine = (message: string, count: number | null): CardLine => {
  const seg = calculateSegments(message)
  return {
    label: "SMS parts per recipient",
    value: `${seg.segments} (${seg.length} characters${seg.encoding === "gsm7" ? "" : ", which needs the shorter-character SMS format"})${count !== null ? `, so about ${int(seg.segments * count)} SMS parts in all, paid by the platform to the SMS provider (nothing is taken from any customer's credits)` : ""}`,
  }
}

const broadcastCard = async (i: EntryInput, ctx: CardCtx): Promise<Card> => {
  const b = asBody(i)
  const channels = arr(b.channels).map(String)
  const message = str(b.message)
  const rec = (b.recipients ?? {}) as Obj
  const lines: CardLine[] = [{ label: "Channels", value: channels.map((c) => CHANNEL_LABEL[c] ?? c).join(", ") || "(none)" }]
  const needsSubject = channels.includes("email") || channels.includes("push")
  if (needsSubject && !str(b.subject).trim()) lines.push(problem("A subject is required for email and push, so this request will be refused."))
  if (b.action !== "init") lines.push(problem('The action must be "init": any other action is refused.'))
  if (str(b.subject)) lines.push({ label: "Subject", value: str(b.subject) })
  lines.push({ label: "Message (sent exactly like this)", value: message })
  const audience = await broadcastAudience(b, ctx)
  lines.push(...audience.lines)
  if (rec.type === "shop_buyers" && !(channels.length === 1 && channels[0] === "sms")) lines.push(problem("Shop buyers can only be sent SMS: this request will be refused."))
  lines.push(audience.count === null ? UNREAD_COUNT : { label: "Recipients", value: `${int(audience.count)}${audience.count === 0 ? " (nobody matches: the request will be refused)" : ""}` })
  if (audience.count !== null && audience.count > RECIPIENTS_MAX) lines.push(problem(`More than ${int(RECIPIENTS_MAX)} people: the request will be refused.`))
  if (audience.count !== null && rec.type !== "group" && rec.type !== "shop_buyers") lines.push({ label: "Of these", value: `${audience.withPhone ?? 0} have a phone number and ${audience.withEmail ?? 0} have an email address` })
  if (channels.includes("sms")) {
    lines.push(smsPartsLine(message, audience.count))
    lines.push({ label: "SMS provider", value: b.smsProvider === "moolre" || b.smsProvider === "hubtel" ? `${str(b.smsProvider)} (chosen for this broadcast)` : "the platform's normal routing" })
  }
  if (rec.type === "group") lines.push({ label: "Merge fields", value: b.mergeFields === false ? "[FirstName], [LastName] and [Phone] will NOT be filled in: they go out as typed" : "[FirstName], [LastName] and [Phone] are filled in for each person" })
  if (rec.type === "shop_buyers") lines.push({ label: "Shop fields", value: "[ShopName], [ShopLink], [ShopCode] and [Phone] are filled in for each person; with [ShopCode] in the text, buyers of shops with no active code are skipped" })
  lines.push({ label: "How it is sent", value: `The recipients are queued, the first ${FIRST_BATCH} recipients are sent right now and the rest is sent by the broadcast job in batches, even if nobody keeps the page open. It cannot be recalled once sent; failed ones can be retried from the history.` })
  return { summary: "Send a broadcast message", lines }
}

const broadcastRetryCard = async (i: EntryInput, ctx: CardCtx): Promise<Card> => {
  const id = str(asBody(i).broadcastId)
  const r = await rowBy(ctx, "broadcast_logs", "id, channels, subject, message, status, target_type", "id", id)
  const row = rowOf(r)
  const lines: CardLine[] = [{ label: "Broadcast", value: row ? `${short(id)}, ${shown(row.target_type)} audience, status ${shown(row.status)}` : `id ${id}` }, ...noteLine(r)]
  if (row) {
    lines.push({ label: "Channels", value: arr(row.channels).map((c) => CHANNEL_LABEL[String(c)] ?? String(c)).join(", ") })
    if (str(row.subject)) lines.push({ label: "Subject", value: str(row.subject) })
    lines.push({ label: "Message (re-sent exactly like this)", value: shown(row.message) })
  }
  const failed = await readCount(() => ctx.db.from("broadcast_recipients").select("id", { count: "exact", head: true }).eq("broadcast_id", id).eq("status", "failed"))
  lines.push({ label: "Failed recipients to re-send", value: failed === null ? "could not be counted just now" : `${failed}${failed === 0 ? " (nothing to retry: no message is sent)" : ""}` })
  lines.push({ label: "How it is sent", value: `Only the channels that failed for each person are sent again, so nobody gets a message twice on a channel that worked. The first ${FIRST_BATCH} recipients are sent right now and the rest by the broadcast job.` })
  return { summary: "Retry the failed recipients of a broadcast", lines }
}

const NOTIFY_ROLE: Record<string, string> = { all_dealers: "dealer", all_users: "user", all_admins: "admin" }

const notifyCard = async (i: EntryInput, ctx: CardCtx): Promise<Card> => {
  const b = asBody(i)
  const target = str(b.target)
  const channels = (b.channels === undefined ? ["push"] : arr(b.channels)).map(String)
  const title = str(b.title)
  const body = str(b.body)
  const lines: CardLine[] = [{ label: "Channels", value: channels.map((c) => CHANNEL_LABEL[c] ?? c).join(", ") }]
  let users: Obj[] | null = []
  if (target === "specific_user") {
    if (!b.user_id) lines.push(problem("user_id is required to notify a single user: the request will be refused."))
    else {
      const u = await rowBy(ctx, "users", "id, first_name, last_name, email, phone_number", "id", str(b.user_id))
      const row = rowOf(u)
      users = row ? [row] : u.state === "unread" ? null : []
      lines.push({ label: "Recipient", value: row ? `${fullName(row) || "(no name)"} (${[str(row.phone_number), str(row.email)].filter(Boolean).join(", ") || "no phone or email on file"})` : u.state === "unread" ? `user ${str(b.user_id)} (could not be looked up just now)` : `No user ${str(b.user_id)} exists: nothing will be sent` })
    }
  } else {
    const role = NOTIFY_ROLE[target]
    if (!role) lines.push(problem("Unknown target: the request will be refused."))
    else {
      users = await readRows(() => ctx.db.from("users").select("id, email, phone_number").eq("role", role))
      lines.push({ label: "Audience", value: `Every user with the role ${role}` })
    }
  }
  lines.push(users === null ? UNREAD_COUNT : { label: "Recipients", value: String(users.length) })
  if (users) {
    const withPhone = users.filter((u) => !!u.phone_number).length
    const withEmail = users.filter((u) => !!u.email).length
    if (channels.includes("push")) lines.push({ label: "Push notification", value: `Title "${title}", text "${body}" (sent to each recipient's registered devices)` })
    if (channels.includes("sms")) {
      const full = `${title}: ${body}`
      const sms = full.slice(0, 160)
      lines.push({ label: "SMS text (exactly as sent)", value: sms + (full.length > 160 ? " [the rest is cut off at 160 characters]" : "") })
      lines.push({ label: "SMS recipients", value: `${withPhone} of ${users.length} have a phone number; ${calculateSegments(sms).segments} SMS part each, paid by the platform (nothing is taken from anyone's credits)` })
    }
    if (channels.includes("email")) {
      lines.push({ label: "Email subject", value: title })
      lines.push({ label: "Email body (HTML)", value: b.email_html !== undefined ? str(b.email_html) : `<p>${body}</p>` })
      lines.push({ label: "Email plain text", value: body })
      lines.push({ label: "Email recipients", value: `${withEmail} of ${users.length} have an email address` })
    }
  }
  lines.push({ label: "How it is sent", value: "Sent to one recipient after another while the request runs; it cannot be recalled." })
  return { summary: "Send a notification", lines }
}

const testEmailCard = async (i: EntryInput): Promise<Card> => {
  const to = str(asBody(i).to)
  return {
    summary: "Send a test email",
    lines: [
      { label: "To", value: to },
      { label: "Subject", value: "Test Email from DataGod" },
      { label: "Body", value: "Email Provider Test. This is a test email to verify your email configuration. It lists the email provider, the sender name and address, and the time it was sent. It ends: This is a test email sent from the DataGod admin panel." },
      { label: "Channel", value: `Email through the configured provider (${process.env.EMAIL_PROVIDER || "brevo (default)"})` },
    ],
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Support threads and complaints
// ---------------------------------------------------------------------------------------------------------------------

async function customerName(ctx: CardCtx, userId: string): Promise<string> {
  const row = rowOf(await rowBy(ctx, "users", "id, first_name, last_name", "id", userId))
  return row ? fullName(row) || "(no name)" : `user ${short(userId)}`
}

const supportThreadCard = async (i: EntryInput, ctx: CardCtx): Promise<Card> => {
  const b = asBody(i)
  const id = asParams(i).id ?? ""
  const r = await rowBy(ctx, "support_threads", "id, user_id, subject, status, handler", "id", id)
  const row = rowOf(r)
  const lines: CardLine[] = [{ label: "Support chat", value: row ? `${shown(row.subject)} (${short(id)}), ${shown(row.status)}, handled by ${shown(row.handler)}` : `id ${id}` }, ...noteLine(r)]
  if (row) lines.push({ label: "Customer", value: await customerName(ctx, str(row.user_id)) })
  const closed = row ? row.status !== "open" : false
  if (b.action === "reply") {
    if (!str(b.message).trim()) lines.push(problem("A reply needs a message: the request will be refused."))
    lines.push({ label: "Reply (sent exactly like this)", value: str(b.message) })
    if (closed) lines.push(problem("This thread is already closed, so the reply will be refused."))
    lines.push({ label: "What happens", value: "The reply is added to the customer's support chat and the chat is handed to a human (the AI stops answering it)." })
    lines.push({ label: "Notices", value: "The customer gets an in-app notice and a push notification that there is a reply." })
    return { summary: "Reply to a customer's support chat", lines }
  }
  if (b.action === "close") {
    if (closed) lines.push(problem("This thread is already closed: the request will be refused."))
    lines.push({ label: "Closing note (added to the chat, seen by the customer)", value: str(b.note).trim() || "(none)" })
    lines.push({ label: "What happens", value: "The chat is closed for good: the customer cannot add to it." })
    lines.push({ label: "Notices", value: "The customer gets an in-app notice and a push notification that the chat was closed." })
    return { summary: "Close a customer's support chat", lines }
  }
  lines.push({ label: "What happens", value: "The customer's messages in this chat are marked as read by an admin (the customer sees the ticks). No message is sent." })
  return { summary: "Mark a support chat as read", lines }
}

const complaintResolveCard = async (i: EntryInput, ctx: CardCtx): Promise<Card> => {
  const b = asBody(i)
  const id = str(b.id)
  const r = await rowBy(ctx, "complaints", "id, user_id, title, status", "id", id)
  const row = rowOf(r)
  const lines: CardLine[] = [{ label: "Complaint", value: row ? `${shown(row.title)} (${short(id)}), ${shown(row.status)} now` : `id ${id}` }, ...noteLine(r)]
  if (row) lines.push({ label: "Customer", value: await customerName(ctx, str(row.user_id)) })
  if (row && (row.status === "resolved" || row.status === "rejected")) lines.push(problem("This complaint is already closed: the request will be refused."))
  lines.push({ label: "New status", value: str(b.status) })
  lines.push({ label: "Resolution notes (shown to the customer)", value: str(b.resolution_notes).trim() || "(none)" })
  lines.push({ label: "Notices", value: "The customer is told the outcome by in-app notice, email and SMS (the SMS carries the first 80 characters of the notes)." })
  return { summary: `Mark a complaint ${str(b.status)}`, lines }
}

// ---------------------------------------------------------------------------------------------------------------------
// WhatsApp inbox
// ---------------------------------------------------------------------------------------------------------------------

const STALE_MS = 24 * 3600_000
const HANDOFF_NOTE = "You're now chatting with a member of our team. 👋" // same text as POST /api/admin/whatsapp-inbox/takeover

async function convoLines(ctx: CardCtx, phone: string): Promise<{ lines: CardLine[]; row: Obj | null }> {
  const r = await rowBy(ctx, "whatsapp_conversations", "phone_number, wa_profile_name, human_takeover, taken_over_at, latest_inbound_at, wants_human", "phone_number", phone)
  const row = rowOf(r)
  const lines: CardLine[] = [{ label: "Customer (WhatsApp)", value: row ? `${phone}${row.wa_profile_name ? ` (${str(row.wa_profile_name)})` : ""}` : `${phone || "(none)"} (no chat with this number yet)` }, ...(r.state === "unread" ? [UNREAD] : [])]
  return { lines, row }
}

const waSendCard = async (i: EntryInput, ctx: CardCtx): Promise<Card> => {
  const b = asBody(i)
  const phone = digits(b.phone)
  const { lines, row } = await convoLines(ctx, phone)
  if (!phone) lines.push(problem("A phone number is required: the request will be refused."))
  lines.push({ label: "Message (sent exactly like this)", value: str(b.message).trim() })
  const last = row?.latest_inbound_at ? new Date(str(row.latest_inbound_at)).getTime() : NaN
  const stale = !Number.isFinite(last) || Date.now() - last > STALE_MS
  lines.push({ label: "24-hour window", value: stale ? "The customer's last message is more than 24 hours old (or there is none): WhatsApp may silently drop a free-form reply, even though it looks sent." : "Open: the customer wrote within the last 24 hours." })
  lines.push({ label: "Channel", value: "WhatsApp (free-form text through the business number)" })
  lines.push({ label: "Other effects", value: `The message is saved in the chat history. Waiting for a human: ${row?.wants_human === true ? "yes now" : "no"}; sending clears that marker.${row?.human_takeover === true ? " The takeover timer is restarted if the takeover is still running." : ""}` })
  return { summary: "Send a WhatsApp reply", lines }
}

const waTakeoverCard = async (i: EntryInput, ctx: CardCtx): Promise<Card> => {
  const b = asBody(i)
  const { lines } = await convoLines(ctx, digits(b.phone))
  if (b.action === "take") {
    lines.push({ label: "What changes", value: "The bot is muted for this customer and any half-finished bot flow (session) is cleared. The 'waiting for a human' marker is cleared." })
    lines.push({ label: "Message sent to the customer (WhatsApp)", value: HANDOFF_NOTE })
    return { summary: "Take over a WhatsApp chat from the bot", lines }
  }
  lines.push({ label: "What changes", value: "The takeover ends and the bot resumes on the customer's next message. No message is sent." })
  return { summary: "Hand a WhatsApp chat back to the bot", lines }
}

const waBulkCard = async (i: EntryInput, ctx: CardCtx): Promise<Card> => {
  const action = str(asBody(i).action)
  const lines: CardLine[] = []
  if (action === "resolve_complaints") {
    const n = await readCount(() => ctx.db.from("whatsapp_complaints").select("id", { count: "exact", head: true }).eq("status", "open"))
    lines.push({ label: "Open complaints", value: n === null ? "could not be counted just now" : String(n) })
    lines.push({ label: "Resolution note kept", value: "Bulk-resolved from the WhatsApp inbox" })
    lines.push({ label: "What changes", value: "Every open (unclaimed) complaint, from every customer, is marked resolved. Complaints already claimed by an admin stay open. The customers are NOT told." })
    return { summary: "Resolve every open WhatsApp complaint", lines }
  }
  if (action === "clear_wants_human") {
    const n = await readCount(() => ctx.db.from("whatsapp_conversations").select("id", { count: "exact", head: true }).eq("wants_human", true))
    lines.push({ label: "Chats waiting for a human", value: n === null ? "could not be counted just now" : String(n) })
    lines.push({ label: "What changes", value: "The 'wants a human' marker is removed from all of them. Complaints are not resolved and nothing is sent." })
    return { summary: "Clear every 'wants a human' marker", lines }
  }
  const n = await readCount(() => ctx.db.from("whatsapp_conversations").select("id", { count: "exact", head: true }).not("latest_inbound_at", "is", null))
  lines.push({ label: "Chats marked read", value: n === null ? "could not be counted just now" : String(n) })
  lines.push({ label: "What changes", value: "Every chat that has a customer message is marked read by an admin (the unread dots go away). Nothing is sent." })
  return { summary: "Mark every WhatsApp chat as read", lines }
}

const waResolveComplaintCard = async (i: EntryInput, ctx: CardCtx): Promise<Card> => {
  const b = asBody(i)
  const phone = digits(b.phone)
  const { lines } = await convoLines(ctx, phone)
  const n = await readCount(() => ctx.db.from("whatsapp_complaints").select("id", { count: "exact", head: true }).eq("phone_number", phone).eq("status", "open"))
  lines.push({ label: "Open complaints", value: n === null ? "could not be counted just now" : String(n) })
  lines.push({ label: "Resolution note", value: (typeof b.note === "string" ? b.note : "Resolved from the WhatsApp inbox").slice(0, 2000) })
  lines.push({ label: "What changes", value: "The customer's open (unclaimed) complaints are marked resolved; complaints already claimed by an admin stay as they are." })
  lines.push({ label: "Notices", value: "Each complainant is told by email and SMS that it was resolved (the SMS carries the start of the note)." })
  return { summary: "Resolve a customer's open WhatsApp complaints", lines }
}

const cashbackCard = async (i: EntryInput, ctx: CardCtx): Promise<Card> => {
  const b = asBody(i)
  const stored = await settingRows(ctx, "admin_settings", ["whatsapp_cashback_visibility"])
  const cur = (stored?.get("whatsapp_cashback_visibility") ?? {}) as Obj
  const lines: CardLine[] = []
  if (!stored) lines.push(UNREAD)
  const labels: Record<string, string> = { networkPlans: "network plans with cashback", payBills: "pay bills with cashback", cashbackAirtime: "cashback airtime" }
  for (const k of ["networkPlans", "payBills", "cashbackAirtime"]) {
    if (b[k] !== undefined) lines.push({ label: `${k} (${labels[k]})`, value: change(stored ? onOff(cur[k] === true) : "unknown", onOff(b[k] === true)) })
  }
  if (lines.every((l) => l === UNREAD)) lines.push(problem("No switch was given: the request will be refused."))
  lines.push({ label: "Effect", value: "The WhatsApp bots (main and shop) start or stop offering these cashback items to customers straight away." })
  return { summary: "Change the WhatsApp bots' cashback switches", lines }
}

// ---------------------------------------------------------------------------------------------------------------------
// Query / body shapes
// ---------------------------------------------------------------------------------------------------------------------

const providerPick = z.enum(["moolre", "mnotify", "both"])
const providerOne = z.enum(["moolre", "mnotify"])
const sectionEnum = z.enum(["switch", "caps", "moderation", "api_limit", "roles", "sender_pool", "platform_senders", "platform_keywords", "business_lists", "pricing", "hubtel", "hubtel_manual_balance"])
const channelEnum = z.enum(["sms", "email", "push", "whatsapp"])
const phonesField = z.union([z.string().min(1).max(100000), z.array(z.string().max(40)).min(1).max(5000)])
const nonBlank = (max: number) => z.string().max(max).refine((s) => s.trim().length > 0, "must not be empty")
const personSchema = z.object({ id: uuid.optional(), email: z.string().email().max(200).optional(), phone: z.string().max(25).optional(), name: z.string().max(100).optional() }).strict()
const anyProvider = z.enum(["moolre", "mnotify", "brevo", "hubtel"])
const waPhone = z.string().trim().min(5).max(20)

const recipientsSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("roles"), roles: z.array(z.string().min(1).max(40)).min(1).max(10) }).strict(),
  z.object({ type: z.literal("specific"), users: z.array(personSchema).min(1).max(200) }).strict(),
  z.object({ type: z.literal("group"), groupId: uuid }).strict(),
  z.object({ type: z.literal("shop_owners") }).strict(),
  z.object({ type: z.literal("shop_buyers"), shopIds: z.union([z.literal("all"), z.array(uuid).min(1).max(200)]), sinceDays: z.union([z.literal(30), z.literal(90), z.literal(180)]).optional() }).strict(),
])

const sinceField = z.union([z.enum(["all", "30", "90", "180"]), z.literal(30), z.literal(90), z.literal(180)])
const bundleBody = {
  units: z.number().int().min(1).max(10_000_000),
  price_ghs: z.number().finite().gt(0).max(100_000),
  mode: z.enum(["platform", "business"]),
  sort_order: z.number().int().min(-10000).max(10000),
}
const resultSender = ["id", "sender_id", "local_status", "kyc_free", "is_pool", "approved_at", "revoked_at", "rejection_reason", "submitted_at", "created_at", "sms_account_id"]

export const MESSAGING_ENTRIES: CatalogEntry[] = [
  // ---- SMS centre: address book
  mk({
    id: "sms_groups.list", page: SMS_CENTRE, summary: "List the SMS address-book groups with their contact counts.",
    method: "GET", path: "/api/admin/sms-groups", kind: "lookup", risk: "normal", auth: "admin",
    resultKeep: ["data[].id", "data[].name", "data[].description", "data[].contact_count", "data[].created_at"],
  }),
  mk({
    id: "sms_groups.detail", page: SMS_CENTRE, summary: "Show one SMS group and its contacts.",
    method: "GET", path: "/api/admin/sms-groups/:id", params: { id: "uuid" }, kind: "lookup", risk: "normal", auth: "admin",
    resultKeep: ["data.group.id", "data.group.name", "data.group.description", "data.contacts[].id", "data.contacts[].phone_number", "data.contacts[].first_name", "data.contacts[].last_name", "data.contacts[].opted_out"],
  }),
  mk({
    id: "sms_groups.create", page: SMS_CENTRE, summary: "Create an empty SMS address-book group.",
    method: "POST", path: "/api/admin/sms-groups", body: z.object({ name: z.string().trim().min(1).max(100), description: optText(500).nullable().optional() }).strict(),
    kind: "change", risk: "normal", auth: "admin", card: groupCreateCard,
  }),
  mk({
    id: "sms_groups.update", page: SMS_CENTRE, summary: "Rename or re-describe an SMS group.",
    method: "PATCH", path: "/api/admin/sms-groups/:id", params: { id: "uuid" }, body: z.object({ name: z.string().trim().min(1).max(100).optional(), description: optText(500).nullable().optional() }).strict(),
    kind: "change", risk: "normal", auth: "admin", card: groupUpdateCard,
  }),
  mk({
    id: "sms_groups.delete", page: SMS_CENTRE, summary: "Delete an SMS group and every contact in it for good.",
    method: "DELETE", path: "/api/admin/sms-groups/:id", params: { id: "uuid" }, kind: "change", risk: "danger", auth: "admin", card: groupDeleteCard,
  }),
  mk({
    id: "sms_contacts.add", page: SMS_CENTRE, summary: "Add one contact, or import a list of contacts, into an SMS group.",
    method: "POST", path: "/api/admin/sms-contacts",
    body: z.object({
      group_id: uuid, phone_number: z.string().max(25).optional(), first_name: optText(100).nullable().optional(), last_name: optText(100).nullable().optional(),
      rows: z.array(z.object({ phone_number: z.string().max(25), first_name: optText(100).nullable().optional(), last_name: optText(100).nullable().optional() }).strict()).min(1).max(500).optional(),
    }).strict(),
    kind: "change", risk: "normal", auth: "admin", card: contactAddCard,
  }),
  mk({
    id: "sms_contacts.opt_out", page: SMS_CENTRE, summary: "Opt an SMS contact out of, or back into, group broadcasts.",
    method: "PATCH", path: "/api/admin/sms-contacts/:id", params: { id: "uuid" }, body: z.object({ opted_out: bool }).strict(),
    kind: "change", risk: "normal", auth: "admin", card: contactOptCard,
  }),
  mk({
    id: "sms_contacts.delete", page: SMS_CENTRE, summary: "Delete one SMS contact.",
    method: "DELETE", path: "/api/admin/sms-contacts/:id", params: { id: "uuid" }, kind: "change", risk: "normal", auth: "admin", card: contactDeleteCard,
  }),
  mk({
    id: "sms_templates.list", page: SMS_CENTRE, summary: "List the saved SMS templates.",
    method: "GET", path: "/api/admin/sms-templates", kind: "lookup", risk: "normal", auth: "admin",
    resultKeep: ["data[].id", "data[].name", "data[].body", "data[].updated_at"],
  }),
  mk({
    id: "sms_templates.create", page: SMS_CENTRE, summary: "Save a new SMS template.",
    method: "POST", path: "/api/admin/sms-templates", body: z.object({ name: z.string().trim().min(1).max(100), body: z.string().trim().min(1).max(1000) }).strict(),
    kind: "change", risk: "normal", auth: "admin", card: templateCreateCard,
  }),
  mk({
    id: "sms_templates.update", page: SMS_CENTRE, summary: "Edit an SMS template's name or text.",
    method: "PATCH", path: "/api/admin/sms-templates/:id", params: { id: "uuid" }, body: z.object({ name: z.string().trim().min(1).max(100).optional(), body: z.string().trim().min(1).max(1000).optional() }).strict(),
    kind: "change", risk: "normal", auth: "admin", card: templateUpdateCard,
  }),
  mk({
    id: "sms_templates.delete", page: SMS_CENTRE, summary: "Delete an SMS template.",
    method: "DELETE", path: "/api/admin/sms-templates/:id", params: { id: "uuid" }, kind: "change", risk: "normal", auth: "admin", card: templateDeleteCard,
  }),
  mk({
    id: "sms_opt_outs.list", page: SMS_CENTRE, summary: "List the numbers on the marketing SMS do-not-text list (the newest 500).",
    method: "GET", path: "/api/admin/sms-opt-outs", kind: "lookup", risk: "normal", auth: "admin",
    resultKeep: ["data.total", "data.items[].phone", "data.items[].reason", "data.items[].created_at"],
  }),
  mk({
    id: "sms_opt_outs.add", page: SMS_CENTRE, summary: "Add numbers to the marketing SMS do-not-text list.",
    method: "POST", path: "/api/admin/sms-opt-outs", body: z.object({ phones: phonesField, reason: optText(200).optional() }).strict(),
    kind: "change", risk: "normal", auth: "admin", card: optOutAddCard,
  }),
  mk({
    id: "sms_opt_outs.remove", page: SMS_CENTRE, summary: "Remove numbers from the do-not-text list, so they get marketing SMS again.",
    method: "DELETE", path: "/api/admin/sms-opt-outs", body: z.object({ phones: phonesField }).strict(),
    kind: "change", risk: "danger", auth: "admin", card: optOutRemoveCard,
  }),

  // ---- SMS centre: sender IDs and provider routing
  mk({
    id: "sms_sender_ids.list", page: SMS_CENTRE, summary: "List every sender ID with its Moolre and mNotify status.",
    method: "GET", path: "/api/admin/sms-sender-ids", kind: "lookup", risk: "normal", auth: "admin",
    resultKeep: ["data[].id", "data[].sender_id", "data[].sms_account_id", "data[].local_status", "data[].moolre_status", "data[].mnotify_local_status", "data[].mnotify_status", "data[].submitted_at"],
  }),
  mk({
    id: "sms_sender_ids.submit", page: SMS_CENTRE, summary: "Add a platform sender ID as pending (no provider is contacted).",
    method: "POST", path: "/api/admin/sms-sender-ids", body: z.object({ sender_id: z.string().trim().min(1).max(11) }).strict(),
    kind: "change", risk: "normal", auth: "admin", card: senderSubmitCard,
  }),
  mk({
    id: "sms_sender_ids.approve", page: SMS_CENTRE, summary: "Approve a sender ID (a customer's request is approved by the platform rules and the customer is told).",
    method: "POST", path: "/api/admin/sms-sender-ids/approve", body: z.object({ id: uuid, provider: providerPick }).strict(),
    kind: "change", risk: "danger", auth: "admin", card: senderApproveCard,
  }),
  mk({
    id: "sms_sender_ids.reject", page: SMS_CENTRE, summary: "Reject a sender ID (a customer's request gets the reason and is told).",
    method: "POST", path: "/api/admin/sms-sender-ids/reject", body: z.object({ id: uuid, provider: providerPick, reason: optText(300).optional() }).strict(),
    kind: "change", risk: "danger", auth: "admin", card: senderRejectCard,
  }),
  mk({
    id: "sms_sender_ids.fetch_status", page: SMS_CENTRE, summary: "Ask one provider for the current status of a sender ID and save it.",
    method: "POST", path: "/api/admin/sms-sender-ids/fetch-status", body: z.object({ id: uuid, provider: providerOne }).strict(),
    kind: "change", risk: "normal", auth: "admin", timeoutMs: 30000,
    card: senderProviderCard("Check a sender ID's status with a provider", (p) => `${p} is asked for the status of this sender ID and the answer is saved on it (a customer's own sender IDs are never activated by a provider answer). No message is sent.`),
  }),
  mk({
    id: "sms_sender_ids.poll", page: SMS_CENTRE, summary: "Check every pending platform sender ID with the providers.",
    method: "POST", path: "/api/admin/sms-sender-ids/poll", kind: "change", risk: "normal", auth: "admin", timeoutMs: 60000, card: senderPollCard,
  }),
  mk({
    id: "sms_sender_ids.push", page: SMS_CENTRE, summary: "Register a platform sender ID with one provider.",
    method: "POST", path: "/api/admin/sms-sender-ids/push", body: z.object({ id: uuid, provider: providerOne }).strict(),
    kind: "change", risk: "normal", auth: "admin", timeoutMs: 30000,
    card: senderProviderCard("Register a sender ID with a provider", (p) => `A registration request for this sender ID is sent to ${p} now. It is then checked by status checks until the provider approves it. No customer message is sent.`),
  }),
  mk({
    id: "sms_settings.read", page: SMS_CENTRE, summary: "Show the SMS provider routing: primary, fallbacks, per-category provider and whether customers may choose.",
    method: "GET", path: "/api/admin/sms-settings", kind: "lookup", risk: "normal", auth: "admin",
    resultKeep: ["data.primary", "data.fallbacks", "data.categoryProviders", "data.tenantProviderChoice"],
  }),
  mk({
    id: "sms_settings.set", page: SMS_CENTRE, summary: "Change the SMS provider routing: primary, fallbacks, per-category provider, customer choice.",
    method: "PATCH", path: "/api/admin/sms-settings",
    body: z.object({
      primary: anyProvider.optional(),
      fallbacks: z.array(anyProvider).max(4).optional(),
      categoryProviders: z.record(z.string().refine((k) => (SMS_CATEGORIES as readonly string[]).includes(k), "unknown SMS category"), z.enum(["global", "moolre", "hubtel"])).optional(),
      tenantProviderChoice: bool.optional(),
    }).strict(),
    kind: "change", risk: "danger", auth: "admin", card: routingCard,
  }),

  // ---- SMS platform: bundles, credits, supply, shop SMS
  mk({
    id: "sms_bundles.list", page: SMS_PLATFORM, summary: "List every SMS bundle with its credits, price and whether it is on sale.",
    method: "GET", path: "/api/admin/sms/bundles", kind: "lookup", risk: "normal", auth: "admin",
    resultKeep: ["bundles[].id", "bundles[].name", "bundles[].units", "bundles[].price_ghs", "bundles[].active", "bundles[].mode", "bundles[].owner_type_scope", "bundles[].sort_order"],
  }),
  mk({
    id: "sms_bundles.create", page: SMS_PLATFORM, summary: "Create an SMS bundle that customers can buy.",
    method: "POST", path: "/api/admin/sms/bundles",
    body: z.object({ name: z.string().trim().min(1).max(100), units: bundleBody.units, price_ghs: bundleBody.price_ghs, owner_type_scope: optText(40).optional(), mode: bundleBody.mode.optional(), sort_order: bundleBody.sort_order.optional() }).strict(),
    kind: "change", risk: "money", auth: "admin", card: bundleCreateCard,
  }),
  mk({
    id: "sms_bundles.update", page: SMS_PLATFORM, summary: "Change an SMS bundle: name, credits, price, on/off sale, mode or order.",
    method: "PATCH", path: "/api/admin/sms/bundles",
    body: z.object({ id: uuid, name: z.string().trim().min(1).max(100).optional(), units: bundleBody.units.optional(), price_ghs: bundleBody.price_ghs.optional(), active: bool.optional(), owner_type_scope: optText(40).optional(), mode: bundleBody.mode.optional(), sort_order: bundleBody.sort_order.optional() }).strict(),
    kind: "change", risk: "money", auth: "admin", card: bundleUpdateCard,
  }),
  mk({
    id: "sms_bundles.delete", page: SMS_PLATFORM, summary: "Delete an SMS bundle that has been switched off for at least 48 hours.",
    method: "DELETE", path: "/api/admin/sms/bundles", query: z.object({ id: uuid }).strict(), kind: "change", risk: "money", auth: "admin", card: bundleDeleteCard,
  }),
  mk({
    id: "sms_credits.allocate", page: SMS_PLATFORM, summary: "Give an SMS account free credits (only added when the wholesale balance backs them, otherwise pending).",
    method: "POST", path: "/api/admin/sms/allocate", body: z.object({ accountId: uuid, units: z.number().int().min(1).max(1_000_000), requestId: uuid.optional() }).strict(),
    kind: "change", risk: "money", auth: "admin", card: allocateCard,
  }),
  mk({
    id: "sms_supply.read", page: SMS_PLATFORM, summary: "Show the SMS supply: provider balance in credits, credits customers hold, pending credits and headroom.",
    method: "GET", path: "/api/admin/sms-supply", kind: "lookup", risk: "normal", auth: "admin",
    resultKeep: ["data.wholesaleBalance", "data.totalUsable", "data.totalPending", "data.headroom"],
  }),
  mk({
    id: "shop_sms.read", page: SMS_PLATFORM, summary: "Show the metered SMS settings, revenue, accounts and flagged sends (flag reasons only, not message text).",
    method: "GET", path: "/api/admin/shop-sms", kind: "lookup", risk: "normal", auth: "admin",
    resultKeep: ["data.settings", "data.revenue", "data.accounts[].id", "data.accounts[].owner_type", "data.accounts[].status", "data.accounts[].unit_balance", "data.flagged[].id", "data.flagged[].sms_account_id", "data.flagged[].flag_reason", "data.flagged[].recipients_count", "data.flagged[].created_at", "data.suspendedAccountIds"],
  }),
  mk({
    id: "shop_sms.settings", page: SMS_PLATFORM, summary: "Change the metered SMS settings: activation fee, welcome bonus, price per credit, keyword and link lists, the on/off switch.",
    method: "PATCH", path: "/api/admin/shop-sms",
    body: z.object({
      sms_activation_fee: z.number().finite().min(0).max(10_000).optional(), sms_welcome_bonus_credits: z.number().int().min(0).max(100_000).optional(),
      sms_blocked_keywords: z.array(z.string().max(60)).max(500).optional(), sms_allowed_link_domains: z.array(z.string().max(100)).max(500).optional(),
      sms_feature_enabled: bool.optional(), sms_price_per_credit: z.number().finite().min(0.001).max(100).optional(),
    }).strict(),
    kind: "change", risk: "danger", auth: "admin", card: shopSmsSettingsCard,
  }),
  mk({
    id: "shop_sms.moderate", page: SMS_PLATFORM, summary: "Dismiss a flagged SMS send, or suspend / unsuspend a shop's SMS account.",
    method: "POST", path: "/api/admin/shop-sms",
    body: z.object({ action: z.enum(["dismiss_flag", "set_suspended"]), logId: z.string().regex(/^\d{1,18}$/).optional(), accountId: uuid.optional(), suspended: bool.optional() }).strict(),
    kind: "change", risk: "danger", auth: "admin", card: shopSmsActionCard,
  }),

  // ---- SMS platform console
  mk({
    id: "sms_platform.overview", page: SMS_PLATFORM, summary: "Show the SMS platform overview: revenue, credits sold, reviews and flags waiting, supply and policy.",
    method: "GET", path: "/api/admin/sms-platform/overview", kind: "lookup", risk: "normal", auth: "admin",
    resultKeep: ["data.stats", "data.tabCounts", "data.unrecorded", "data.supply.provider", "data.supply.backedCredits", "data.supply.balanceGhs", "data.supply.ratePerSms", "data.supply.queuedUnsent", "data.supply.balanceSource", "data.supply.error", "data.featureEnabled", "data.policyEnforced", "data.provider", "data.policyPreview"],
  }),
  mk({
    id: "sms_platform.accounts", page: SMS_PLATFORM, summary: "Search SMS accounts by owner email or mode, with balances and flags.",
    method: "GET", path: "/api/admin/sms-platform/accounts", query: z.object({ q: optText(100).optional(), page: page.optional() }).strict(), kind: "lookup", risk: "normal", auth: "admin",
    resultKeep: ["data.rows[].id", "data.rows[].email", "data.rows[].owner_type", "data.rows[].mode", "data.rows[].status", "data.rows[].unit_balance", "data.rows[].bought", "data.rows[].used", "data.rows[].default_sender", "data.rows[].api_rate_limit_override", "data.rows[].review_hold", "data.rows[].fraud_flag_count", "data.rows[].created_at", "data.total", "data.page", "data.pageSize"],
  }),
  mk({
    id: "sms_platform.account_update", page: SMS_PLATFORM, summary: "Change an SMS account's mode, API rate limit or review hold.",
    method: "PATCH", path: "/api/admin/sms-platform/accounts/:id", params: { id: "uuid" },
    body: z.object({ mode: bundleBody.mode.optional(), api_rate_limit_override: z.number().int().min(1).max(10_000).nullable().optional(), review_hold: bool.optional() }).strict(),
    kind: "change", risk: "danger", auth: "admin", card: platformAccountCard,
  }),
  mk({
    id: "sms_platform.reviews", page: SMS_PLATFORM, summary: "List business verification applications (default: submitted) without their identity documents.",
    method: "GET", path: "/api/admin/sms-platform/business-reviews", query: z.object({ status: z.enum(["submitted", "approved", "rejected", "draft", "all"]).optional() }).strict(), kind: "lookup", risk: "normal", auth: "admin",
    resultKeep: ["data[].id", "data[].sms_account_id", "data[].business_name", "data[].description", "data[].website", "data[].status", "data[].submitted_at", "data[].reviewed_at", "data[].rejection_reason", "data[].has_ghana_card_doc", "data[].has_registration_doc", "data[].account.email", "data[].account.mode"],
  }),
  mk({
    id: "sms_platform.review_decide", page: SMS_PLATFORM, summary: "Approve, reject or retry the Business-mode switch for a business verification (the owner is told).",
    method: "POST", path: "/api/admin/sms-platform/business-reviews/:id", params: { id: "uuid" }, body: z.object({ action: z.enum(["approve", "reject", "retry_mode"]), reason: optText(500).optional() }).strict(),
    kind: "change", risk: "danger", auth: "admin", card: businessReviewCard,
  }),
  mk({
    id: "sms_platform.flags", page: SMS_PLATFORM, summary: "List SMS flags and the campaigns held for review, with the flagged message text (held campaigns on page 1 only).",
    method: "GET", path: "/api/admin/sms-platform/flags", query: z.object({ severity: z.enum(["fraud", "info"]).optional(), status: z.enum(["open", "dismissed", "actioned"]).optional(), page: page.optional() }).strict(), kind: "lookup", risk: "normal", auth: "admin",
    resultKeep: ["data.rows[].id", "data.rows[].source", "data.rows[].sms_account_id", "data.rows[].severity", "data.rows[].reason", "data.rows[].matched", "data.rows[].status", "data.rows[].message", "data.rows[].created_at", "data.total", "data.held[].id", "data.held[].log_id", "data.held[].sms_account_id", "data.held[].email", "data.held[].reason", "data.held[].code", "data.held[].message", "data.held[].sender_id", "data.held[].recipients_count", "data.held[].segments", "data.held[].credits_reserved", "data.held[].created_at", "data.held[].scheduled_for", "data.heldTotal", "data.page", "data.pageSize"],
  }),
  mk({
    id: "sms_platform.flag_action", page: SMS_PLATFORM, summary: "Dismiss an SMS flag, or suspend the SMS account behind it.",
    method: "POST", path: "/api/admin/sms-platform/flags/:id", params: { id: "slug" }, body: z.object({ source: z.enum(["flag", "legacy"]), action: z.enum(["dismiss", "suspend"]) }).strict(),
    kind: "change", risk: "danger", auth: "admin", card: flagActionCard,
  }),
  mk({
    id: "sms_platform.hubtel_balance", page: SMS_PLATFORM, summary: "Show the Hubtel balance the SMS credit checks would use, the manual balance and the relay reading.",
    method: "GET", path: "/api/admin/sms-platform/hubtel-balance", kind: "lookup", risk: "normal", auth: "admin",
    resultKeep: ["data.current", "data.manual.amountGhs", "data.manual.setAt", "data.manual.fresh", "data.preferManual", "data.relay"],
  }),
  mk({
    id: "sms_platform.messages", page: SMS_PLATFORM, summary: "Search customers' sent SMS campaigns (counts and delivery, not message text).",
    method: "GET", path: "/api/admin/sms-platform/messages",
    query: z.object({ q: optText(100).optional(), status: z.enum(["queued", "sending", "sent", "partial", "failed", "blocked", "held", "scheduled"]).optional(), page: page.optional() }).strict(), kind: "lookup", risk: "normal", auth: "admin",
    resultKeep: ["data.rows[].id", "data.rows[].sms_account_id", "data.rows[].mode", "data.rows[].sender_id", "data.rows[].status", "data.rows[].recipients_count", "data.rows[].segments", "data.rows[].credits_used", "data.rows[].created_at", "data.rows[].tracked", "data.rows[].delivered", "data.rows[].failed", "data.rows[].pending", "data.total", "data.page", "data.pageSize"],
  }),
  mk({
    id: "sms_platform.sender_ids", page: SMS_PLATFORM, summary: "List customers' and the platform's sender IDs by status and scope.",
    method: "GET", path: "/api/admin/sms-platform/sender-ids", query: z.object({ status: z.enum(["pending", "active", "paused", "rejected", "revoked", "all"]).optional(), scope: z.enum(["tenant", "global", "all"]).optional() }).strict(), kind: "lookup", risk: "normal", auth: "admin",
    resultKeep: [...resultSender.map((k) => `data[].${k}`), "data[].account.email", "data[].account.mode"],
  }),
  mk({
    id: "sms_platform.sender_decide", page: SMS_PLATFORM, summary: "Approve, reject or revoke a customer's sender ID (this route sends the customer no notice).",
    method: "POST", path: "/api/admin/sms-platform/sender-ids/:id", params: { id: "uuid" }, body: z.object({ action: z.enum(["approve", "reject", "revoke"]), reason: optText(300).optional() }).strict(),
    kind: "change", risk: "danger", auth: "admin", card: senderPlatformActionCard,
  }),
  mk({
    id: "sms_platform.settings.read", page: SMS_PLATFORM, summary: "Show the SMS platform settings (switch, caps, moderation limits, roles, senders, pricing, Hubtel).",
    method: "GET", path: "/api/admin/sms-platform/settings", kind: "lookup", risk: "normal", auth: "admin",
    resultKeep: ["data.settings.featureEnabled", "data.settings.policyEnforced", "data.settings.allowedRoles", "data.settings.senderPool", "data.settings.caps", "data.settings.autoSuspendFlags", "data.settings.flagReviewThreshold", "data.settings.apiRateLimitDefault", "data.settings.protectedSenderNames", "data.settings.hubtelCostPerSms", "data.settings.hubtelLowBalanceGhs", "data.settings.platformSenders", "data.settings.platformDefaultSender", "data.settings.hubtelManualBalance.amountGhs", "data.settings.hubtelManualBalance.setAt", "data.settings.hubtelPreferManualBalance", "data.pricing"],
  }),
  mk({
    id: "sms_platform.settings.set", page: SMS_PLATFORM, summary: "Change one section of the SMS platform settings (switch, caps, moderation, API limit, roles, senders, keywords, pricing, Hubtel).",
    method: "PATCH", path: "/api/admin/sms-platform/settings", body: z.object({ section: sectionEnum, values: z.record(z.string(), z.unknown()) }).strict(),
    kind: "change", risk: "danger", auth: "admin", card: platformSettingsCard,
  }),

  // ---- SMS health
  mk({
    id: "sms_health.read", page: SMS_HEALTH, summary: "Show how well SMS is being delivered, by message type, provider and sender name, with the latest failures (numbers left out).",
    method: "GET", path: "/api/admin/sms-health", query: z.object({ hours: z.union([z.literal(24), z.literal(72), z.literal(168)]).optional() }).strict(), kind: "lookup", risk: "normal", auth: "admin",
    resultKeep: ["otp_breaker", "window_hours", "overall", "by_type", "by_provider", "recent_failures[].message_type", "recent_failures[].error_message", "recent_failures[].created_at", "sender_health[].sender", "sender_health[].source", "sender_health[].status", "sender_health[].delivery_rate", "sender_health[].registry_status", "sender_health_error"],
  }),

  // ---- Broadcast, notify, test email
  mk({
    id: "broadcast.shop_buyers", page: BROADCAST, summary: "Count the shop buyers an SMS broadcast could reach, per shop, and how many numbers are on the do-not-text list.",
    method: "GET", path: "/api/admin/broadcast/shop-buyers", query: z.object({ since: sinceField.optional() }).strict(), kind: "lookup", risk: "normal", auth: "admin",
    resultKeep: ["data.total", "data.optedOut", "data.shops[].id", "data.shops[].name", "data.shops[].buyers"],
  }),
  mk({
    id: "broadcast.send", page: BROADCAST, summary: "Send a message by SMS, email, push or WhatsApp to a group of users (queued: the first batch goes now, the rest by the broadcast job).",
    method: "POST", path: "/api/admin/broadcast",
    // The handler sets maxDuration 300 because enqueueing a very large audience is paged, but the SEND is queued for the drain
    // cron (only the first 30 recipients go inline), so it stays a card; the request itself is held to the 60 s tool ceiling.
    body: z.object({ action: z.literal("init"), channels: z.array(channelEnum).min(1).max(4), recipients: recipientsSchema, subject: optText(200).optional(), message: nonBlank(5000), smsProvider: z.enum(["moolre", "hubtel", "global"]).optional(), mergeFields: bool.optional() }).strict(),
    kind: "change", risk: "danger", auth: "admin", timeoutMs: 60000, card: broadcastCard,
  }),
  mk({
    id: "broadcast.retry", page: BROADCAST_HISTORY, summary: "Re-send a broadcast to the recipients it failed for (first batch now, the rest by the broadcast job).",
    method: "POST", path: "/api/admin/broadcast/retry", body: z.object({ broadcastId: uuid }).strict(),
    kind: "change", risk: "danger", auth: "admin", timeoutMs: 60000, card: broadcastRetryCard,
  }),
  mk({
    id: "notify.send", page: BROADCAST, summary: "Send a push, SMS and/or email notification to one user, or to every dealer, user or admin.",
    method: "POST", path: "/api/admin/notify",
    body: z.object({ target: z.enum(["specific_user", "all_dealers", "all_users", "all_admins"]), user_id: uuid.optional(), channels: z.array(z.enum(["push", "sms", "email"])).min(1).max(3).optional(), title: nonBlank(200), body: nonBlank(2000), email_html: optText(20000).optional() }).strict(),
    kind: "change", risk: "danger", auth: "admin", timeoutMs: 60000, card: notifyCard,
  }),
  mk({
    id: "test_email.config", page: SETTINGS, summary: "Show which email provider and sender are configured and whether each provider's key is set (never the key).",
    method: "GET", path: "/api/admin/test-email", kind: "lookup", risk: "normal", auth: "admin",
    resultKeep: ["provider", "senderName", "senderEmail", "brevoConfigured", "resendConfigured"],
  }),
  mk({
    id: "test_email.send", page: SETTINGS, summary: "Send the fixed test email to one address to check the email setup.",
    method: "POST", path: "/api/admin/test-email", body: z.object({ to: z.string().trim().email().max(200) }).strict(),
    kind: "change", risk: "normal", auth: "admin", timeoutMs: 30000, card: testEmailCard,
  }),

  // ---- Support chats and complaints (requireSupportAdmin)
  mk({
    id: "support.counts", page: COMPLAINTS, summary: "Show how many support chats are open, how many customer messages are unread and how many older complaints are pending.",
    method: "GET", path: "/api/admin/support/counts", kind: "lookup", risk: "normal", auth: "support_admin",
    resultKeep: ["data.openThreads", "data.unreadMessages", "data.legacyPending"],
  }),
  mk({
    id: "support.threads", page: COMPLAINTS, summary: "List support chats with the customer's name and last message (listing records you as present in the support inbox).",
    method: "GET", path: "/api/admin/support/threads", query: z.object({ status: z.enum(["open", "closed", "all"]).optional(), days: z.number().int().min(1).max(90).optional() }).strict(), kind: "lookup", risk: "normal", auth: "support_admin",
    resultKeep: ["data.threads[].id", "data.threads[].subject", "data.threads[].category", "data.threads[].status", "data.threads[].handler", "data.threads[].needs_human_at", "data.threads[].last_message_at", "data.threads[].unread_count", "data.threads[].user.first_name", "data.threads[].user.last_name", "data.threads[].last_message.sender_role", "data.threads[].last_message.body"],
  }),
  mk({
    id: "support.thread", page: COMPLAINTS, summary: "Read one support chat (opening it marks the customer's messages as delivered to an admin and records you as present).",
    method: "GET", path: "/api/admin/support/threads/:id", params: { id: "uuid" }, kind: "lookup", risk: "normal", auth: "support_admin",
    resultKeep: ["data.id", "data.subject", "data.category", "data.status", "data.handler", "data.order_id", "data.shop_order_id", "data.created_at", "data.user.first_name", "data.user.last_name", "data.messages[].id", "data.messages[].sender_role", "data.messages[].body", "data.messages[].created_at"],
  }),
  mk({
    id: "support.thread_action", page: COMPLAINTS, summary: "Reply to a support chat, close it, or mark it read (reply and close tell the customer; a reply needs a message).",
    method: "POST", path: "/api/admin/support/threads/:id", params: { id: "uuid" },
    body: z.object({ action: z.enum(["reply", "close", "read"]), message: nonBlank(5000).optional(), note: optText(2000).optional() }).strict(),
    kind: "change", risk: "normal", auth: "support_admin", card: supportThreadCard,
  }),
  mk({
    id: "complaints.list", page: COMPLAINTS, summary: "List older (legacy) complaints: every open one, plus the others from the last few days.",
    method: "GET", path: "/api/admin/complaints", query: z.object({ days: z.number().int().min(1).max(90).optional() }).strict(), kind: "lookup", risk: "normal", auth: "support_admin",
    resultKeep: ["data.complaints[].id", "data.complaints[].title", "data.complaints[].description", "data.complaints[].category", "data.complaints[].status", "data.complaints[].priority", "data.complaints[].order_id", "data.complaints[].resolution_notes", "data.complaints[].created_at", "data.complaints[].user.first_name", "data.complaints[].user.last_name"],
  }),
  mk({
    id: "complaints.resolve", page: COMPLAINTS, summary: "Mark a legacy complaint resolved or rejected, with notes the customer is sent.",
    method: "POST", path: "/api/admin/complaints/resolve", body: z.object({ id: uuid, status: z.enum(["resolved", "rejected"]), resolution_notes: z.string().trim().max(2000) }).strict(),
    kind: "change", risk: "normal", auth: "support_admin", card: complaintResolveCard,
  }),

  // ---- WhatsApp inbox
  mk({
    id: "whatsapp_inbox.list", page: WHATSAPP, summary: "List WhatsApp chats, those waiting for a human first, with unread and takeover state.",
    method: "GET", path: "/api/admin/whatsapp-inbox", query: z.object({ search: optText(40).optional(), page: page.optional() }).strict(), kind: "lookup", risk: "normal", auth: "admin",
    resultKeep: ["data[].phone_number", "data[].customer_name", "data[].last_message_preview", "data[].latest_inbound_at", "data[].latest_outbound_at", "data[].human_takeover", "data[].takeover_active", "data[].is_stale", "data[].unread", "data[].wants_human", "count", "page", "limit"],
  }),
  mk({
    id: "whatsapp_inbox.unread", page: WHATSAPP, summary: "Count the WhatsApp chats with unread customer messages.",
    method: "GET", path: "/api/admin/whatsapp-inbox/unread-count", kind: "lookup", risk: "normal", auth: "admin", resultKeep: ["count", "capped"],
  }),
  mk({
    id: "whatsapp_inbox.thread", page: WHATSAPP, summary: "Read one WhatsApp chat (opening it marks the chat as read for admins; the customer sees nothing).",
    method: "GET", path: "/api/admin/whatsapp-inbox/:phone", params: { phone: "slug" }, query: z.object({ after: optText(40).optional() }).strict(), kind: "lookup", risk: "normal", auth: "admin",
    resultKeep: ["conversation.phone_number", "conversation.customer_name", "conversation.human_takeover", "conversation.takeover_active", "conversation.taken_over_by_name", "conversation.is_stale", "conversation.wants_human", "conversation.open_complaints", "messages[].id", "messages[].direction", "messages[].message", "messages[].status", "messages[].created_at"],
  }),
  mk({
    id: "whatsapp_inbox.send", page: WHATSAPP, summary: "Send a free-form WhatsApp reply to one customer.",
    method: "POST", path: "/api/admin/whatsapp-inbox/send", body: z.object({ phone: waPhone, message: nonBlank(4000) }).strict(),
    kind: "change", risk: "normal", auth: "admin", timeoutMs: 30000, card: waSendCard,
  }),
  mk({
    id: "whatsapp_inbox.takeover", page: WHATSAPP, summary: "Take a WhatsApp chat over from the bot (the customer is told) or hand it back.",
    method: "POST", path: "/api/admin/whatsapp-inbox/takeover", body: z.object({ phone: waPhone, action: z.enum(["take", "release"]) }).strict(),
    kind: "change", risk: "normal", auth: "admin", timeoutMs: 30000, card: waTakeoverCard,
  }),
  mk({
    id: "whatsapp_inbox.bulk", page: WHATSAPP, summary: "Inbox-wide clean-up: resolve every open complaint, clear every 'wants a human' marker, or mark every chat read.",
    method: "POST", path: "/api/admin/whatsapp-inbox/bulk", body: z.object({ action: z.enum(["resolve_complaints", "clear_wants_human", "mark_all_read"]) }).strict(),
    kind: "change", risk: "danger", auth: "admin", timeoutMs: 60000, card: waBulkCard,
  }),
  mk({
    id: "whatsapp_inbox.resolve_complaint", page: WHATSAPP, summary: "Resolve one customer's open WhatsApp complaints (the complainant is told by email and SMS).",
    method: "POST", path: "/api/admin/whatsapp-inbox/resolve-complaint", body: z.object({ phone: waPhone, note: optText(2000).optional() }).strict(),
    kind: "change", risk: "normal", auth: "admin", timeoutMs: 30000, card: waResolveComplaintCard,
  }),
  mk({
    id: "whatsapp.cashback.read", page: WHATSAPP, summary: "Show the WhatsApp bots' cashback switches and what the bots offer right now.",
    method: "GET", path: "/api/admin/whatsapp/cashback-visibility", kind: "lookup", risk: "normal", auth: "admin",
    resultKeep: ["switches.networkPlans", "switches.payBills", "switches.cashbackAirtime", "live"],
  }),
  mk({
    id: "whatsapp.cashback.set", page: WHATSAPP, summary: "Switch the WhatsApp bots' cashback items (network plans, pay bills, cashback airtime) on or off.",
    method: "POST", path: "/api/admin/whatsapp/cashback-visibility", body: z.object({ networkPlans: bool.optional(), payBills: bool.optional(), cashbackAirtime: bool.optional() }).strict(),
    kind: "change", risk: "danger", auth: "admin", card: cashbackCard,
  }),
]
