import { z } from "zod"
import type { CardCtx, CardLine, CatalogEntry, EntryInput } from "../types"
import { pageTitleFor } from "../pages"
import { ghanaSignificant, DEFAULT_NETWORK_PREFIXES, type NetworkPrefixMap } from "@/lib/phone-format"
import { assistantSettingsInputSchema, resolveAssistantSettings } from "@/lib/ai-console/settings"
import { DEFAULT_CONFIG } from "@/lib/ai-provider-config"
import { deriveFromLegacy, sanitizeGatewayConfig, SURFACE_KEYS, type GatewayConfig, type SurfaceKey } from "@/lib/payment-gateway/config"
import { isHubtelCollectionReady } from "@/lib/payment-gateway/hubtel-readiness"
import { TOGGLEABLE_PAGES } from "@/lib/custom-domain-pages"
import { isReservedDomainHost } from "@/lib/custom-domains"
import { USSD_CODE_RE } from "@/lib/seo/ussd-codes"
import { validateReviewUrl } from "@/lib/review-prompt"

// Settings group: /api/admin/ settings (and every settings/* switch), gateway (and gateway/hubtel-payments),
// delivery-channels, christmas-theme, custom-domains, support-settings, rate-limits, ai-config (PUT only) and
// ai-knowledge. Most of these are GLOBAL switches that change what every customer sees or can do, so every card
// shows the value that is stored now, the value that will be saved, and what that means for customers. Every handler
// here uses verifyAdminAccess except two GETs (auto-fulfillment and christmas-theme), which check nothing and are
// listed as "other".
//
// Secrets: the five AI provider keys of ai-config PUT (`<provider>_api_key_new`) are secretFields (the secure box)
// and never part of the body schema; a card only says a key "will be replaced" and never shows a stored one.
// ai-config GET stays EXCLUDED (it returns masked key endings and the assistant must not read its own settings).
//
// Left out of the schemas on purpose (the card text could not show them in full, or the handler would take any
// column): settings PUT terms_content* (long legal text: use the page); ai-knowledge PATCH only passes the five real
// columns (the handler spreads the whole body into the update).
//
// A GET whose ONLY write is inserting a default row when none exists yet (settings, afa-auto-fulfillment,
// mtn-auto-fulfillment, mtn-registration-gate, network-prefix-validation) is kind "lookup" (ruling G-default): it never
// changes a saved value.
//
// Schemas that are tighter than the handler (the handler only checks a few types): URLs must be https (or a known
// shape), colors hex, booleans real booleans, text lengths capped. A body schema cannot refuse an empty change (zod
// refine would make it a non-object), so the card says "nothing to change: refused" instead.

type Card = { summary: string; lines: CardLine[] }
type Obj = Record<string, unknown>
type Read = { state: "found"; row: Obj } | { state: "missing" } | { state: "unread" }

const where = (page: string) => ({ page, pageTitle: pageTitleFor(page) ?? page })
const mk = (e: Omit<CatalogEntry, "area" | "pageTitle">): CatalogEntry => ({ ...e, area: "settings", pageTitle: pageTitleFor(e.page) ?? e.page })

const uuid = z.string().uuid()
const bool = z.boolean()
const yes = z.boolean()

const asBody = (i: EntryInput): Obj => (i.body ?? {}) as Obj
const asQuery = (i: EntryInput): Obj => (i.query ?? {}) as Obj
const str = (v: unknown): string => (typeof v === "string" ? v : "")
const onOff = (b: boolean): string => (b ? "ON" : "OFF")
const list = (a: unknown): string => (Array.isArray(a) && a.length > 0 ? a.map(String).join(", ") : "none")
const num = (v: unknown): string => {
  const x = Number(v)
  return Number.isFinite(x) ? String(Math.round(x * 1e6) / 1e6) : "unknown"
}
const pct = (v: unknown): string => `${num(v)}%`
const ghs2 = (v: unknown): string => (Number.isFinite(Number(v)) ? `GHS ${Number(v).toFixed(2)}` : "unknown")
const ghs0 = (v: unknown): string => `GHS ${num(v)}`
const shown = (v: unknown): string => (typeof v === "string" ? (v === "" ? "(empty)" : v) : v === null || v === undefined ? "(not set)" : String(v))
const change = (a: string, b: string): string => `${a} -> ${b}`

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

/** admin_settings value of one key. `value` is the JSON the app stores. */
const adminSetting = (ctx: CardCtx, key: string): Promise<Read> =>
  readOne(() => ctx.db.from("admin_settings").select("value, updated_at").eq("key", key).maybeSingle())

/** app_settings key/value row (value is text). */
const appKeyValue = (ctx: CardCtx, key: string): Promise<Read> =>
  readOne(() => ctx.db.from("app_settings").select("value").eq("key", key).maybeSingle())

/** The singleton app_settings row (key IS NULL). */
const appSingleton = (ctx: CardCtx, cols: string): Promise<Read> =>
  readOne(() => ctx.db.from("app_settings").select(cols).is("key", null).maybeSingle())

const valueOf = (r: Read): Obj | null => (r.state === "found" && r.row.value && typeof r.row.value === "object" && !Array.isArray(r.row.value) ? (r.row.value as Obj) : null)

const UNREAD: CardLine = { label: "Problem", value: "The current setting could not be read just now, so the old value cannot be shown." }

// ---------------------------------------------------------------------------------------------------------------------
// On/off switches stored in admin_settings as { enabled }
// ---------------------------------------------------------------------------------------------------------------------

interface Toggle {
  id: string
  path: string
  page: string
  key: string
  name: string
  defaultOn: boolean
  on: string
  off: string
  read: string
  set: string
  scope: string
  seeds?: boolean
  getAuth?: "admin" | "other"
  getKeep?: string[]
  method?: "POST" | "PUT"
}

const enabledOf = (value: Obj | null, defaultOn: boolean): boolean => (defaultOn ? value?.enabled !== false : value?.enabled === true)

async function switchState(ctx: CardCtx, t: Toggle): Promise<{ state: "ok"; on: boolean; saved: boolean } | { state: "unread" }> {
  const r = await adminSetting(ctx, t.key)
  if (r.state === "unread") return { state: "unread" }
  return { state: "ok", on: enabledOf(valueOf(r), t.defaultOn), saved: r.state === "found" }
}

const nowText = (s: Awaited<ReturnType<typeof switchState>>, t: Toggle): string =>
  s.state === "unread" ? "unknown (could not be read just now)" : `${onOff(s.on)}${s.saved ? "" : ` (nothing saved yet: the built-in default is ${onOff(t.defaultOn)})`}`

function toggleCard(t: Toggle) {
  return async (i: EntryInput, ctx: CardCtx): Promise<Card> => {
    const next = asBody(i).enabled === true
    const s = await switchState(ctx, t)
    const lines: CardLine[] = [
      { label: "Setting", value: t.name },
      { label: "Now", value: nowText(s, t) },
      { label: "After this", value: onOff(next) },
      { label: "What changes", value: next ? t.on : t.off },
      { label: "Who is affected", value: t.scope },
    ]
    if (s.state === "unread") lines.push(UNREAD)
    else if (s.on === next) lines.push({ label: "Note", value: `It is already ${onOff(next)}: saving changes nothing.` })
    return { summary: `Turn ${t.name} ${onOff(next)}`, lines }
  }
}

// Ruling G-default: a GET whose only write is inserting the default row when none exists (idempotent, never changes
// a saved value) is a lookup. `seeds` marks those; it only changes the summary text.
function toggleEntries(t: Toggle): CatalogEntry[] {
  const get: CatalogEntry = mk({
    id: `${t.id}.read`,
    ...where(t.page),
    summary: t.seeds ? `${t.read} (the first read of a never-saved setting stores its default).` : t.read,
    method: "GET",
    path: t.path,
    kind: "lookup",
    risk: "normal",
    auth: t.getAuth ?? "admin",
    resultKeep: t.getKeep ?? ["enabled", "updated_at"],
  })
  const set = mk({
    id: `${t.id}.set`,
    ...where(t.page),
    summary: t.set,
    method: t.method ?? "POST",
    path: t.path,
    body: z.object({ enabled: bool }).strict(),
    kind: "change",
    risk: "danger",
    auth: "admin",
    card: toggleCard(t),
  })
  return [get, set]
}

const TOGGLES: Toggle[] = [
  {
    id: "afa_auto_fulfilment",
    path: "/api/admin/settings/afa-auto-fulfillment",
    page: "/admin/afa-management",
    key: "afa_auto_fulfillment_enabled",
    name: "AFA auto-fulfilment",
    defaultOn: false,
    on: "New AFA registrations are sent to the AFA supplier automatically the moment they are placed.",
    off: "New AFA registrations wait for someone to fulfil them by hand.",
    read: "Show whether AFA registrations are sent to the supplier automatically.",
    set: "Turn AFA auto-fulfilment on or off: whether new AFA registrations go to the supplier by themselves.",
    scope: "Every customer registering for AFA, from now on.",
    seeds: true,
  },
  {
    id: "at_telecel_auto_fulfilment",
    path: "/api/admin/settings/auto-fulfillment",
    page: "/admin/settings/mtn",
    key: "auto_fulfillment_enabled",
    name: "AT-iShare and Telecel auto-fulfilment",
    defaultOn: true,
    on: "AT-iShare and Telecel orders are fulfilled automatically through the supplier.",
    off: "AT-iShare and Telecel orders go to the admin queue and wait to be sent by hand.",
    read: "Show whether AT-iShare and Telecel orders are fulfilled automatically.",
    set: "Turn AT-iShare and Telecel auto-fulfilment on or off. The network list stays AT-iShare and Telecel.",
    scope: "Every AT-iShare and Telecel order placed from now on (orders already placed are not moved).",
    getAuth: "other", // this GET does not check who is asking
    getKeep: ["setting.enabled", "setting.networks", "isDefault", "updatedAt"],
  },
  {
    id: "mtn_auto_fulfilment",
    path: "/api/admin/settings/mtn-auto-fulfillment",
    page: "/admin/settings/mtn",
    key: "mtn_auto_fulfillment_enabled",
    name: "MTN auto-fulfilment",
    defaultOn: false,
    on: "New MTN data orders are sent to the MTN supplier automatically.",
    off: "New MTN data orders go to the admin queue and wait to be sent by hand.",
    read: "Show whether MTN orders are sent to the supplier automatically.",
    set: "Turn MTN auto-fulfilment on or off: whether MTN data orders go to the supplier by themselves.",
    scope: "Every customer buying MTN data, from now on (orders already placed are not moved).",
    seeds: true,
  },
  {
    id: "mtn_registration_gate",
    path: "/api/admin/settings/mtn-registration-gate",
    page: "/admin/settings/mtn",
    key: "mtn_registration_gate_enabled",
    name: "MTN registration gate",
    defaultOn: false,
    on: "Orders for numbers that are not yet registered with MTN are held and not sent to a supplier.",
    off: "Orders go to a supplier whether or not the number is registered with MTN.",
    read: "Show whether orders for unregistered MTN numbers are held.",
    set: "Turn the MTN registration gate on or off: whether orders for numbers not yet registered with MTN are held.",
    scope: "Every MTN order placed from now on.",
    seeds: true,
  },
  {
    id: "network_prefix_validation",
    path: "/api/admin/settings/network-prefix-validation",
    page: "/admin/settings",
    key: "network_prefix_validation_enabled",
    name: "Network prefix check at ordering",
    defaultOn: true,
    on: "An order is refused when the phone number's prefix does not match the network chosen (for example an MTN number on a Telecel bundle).",
    off: "Orders are accepted even when the number's prefix does not match the network chosen, so wrong-network orders can fail at the supplier.",
    read: "Show whether orders are blocked when the number does not match the chosen network.",
    set: "Turn the network-prefix check on or off for every order.",
    scope: "Every customer placing an order, from now on.",
    seeds: true,
  },
  {
    id: "turnstile",
    path: "/api/admin/settings/turnstile",
    page: "/admin/settings",
    key: "turnstile_enabled",
    name: "Turnstile bot check on shop orders",
    defaultOn: true,
    on: "Shop order endpoints require the Cloudflare Turnstile bot check to pass.",
    off: "The bot check is removed from shop order endpoints, so automated abuse is no longer filtered there. Only do this during a Cloudflare outage or a key rotation.",
    read: "Show whether the Cloudflare Turnstile bot check is on for shop orders.",
    set: "Turn the Turnstile bot check on shop orders on or off. It takes effect within seconds.",
    scope: "Every shop visitor placing an order, within seconds.",
  },
  {
    id: "storefront_otp",
    path: "/api/admin/settings/storefront-otp",
    page: "/admin/gateway",
    key: "storefront_otp_required",
    name: "Phone code (OTP) before a guest shop order",
    defaultOn: false,
    on: "A guest must confirm their phone with an SMS code before a shop order is placed (one SMS per attempt).",
    off: "Guests place shop orders without a phone code.",
    read: "Show whether guests must confirm their phone by SMS code before ordering from a shop.",
    set: "Turn the phone-code requirement for guest shop orders on or off (an anti-abuse lever for attacks).",
    scope: "Every guest ordering from any shop, from now on.",
  },
  {
    id: "wallet_otp",
    path: "/api/admin/settings/wallet-otp",
    page: "/admin/gateway",
    key: "wallet_otp_required",
    name: "Wallet top-up and dealer upgrade protection",
    defaultOn: false,
    on: "The wallet top-up and dealer upgrade checkouts drop the Mobile Money channel and cap attempts per user (stops payment-prompt spam).",
    off: "Wallet top-up and dealer upgrade checkouts offer every payment channel again, without the extra limits.",
    read: "Show whether wallet top-ups and dealer upgrades are locked down.",
    set: "Turn the wallet top-up and dealer upgrade protection on or off (an anti-abuse lever for attacks).",
    scope: "Every user topping up their wallet or upgrading, from now on.",
  },
  {
    id: "ussd_shop_memory",
    path: "/api/admin/settings/ussd-shop-memory",
    page: "/admin/settings",
    key: "ussd_shop_memory_enabled",
    name: "USSD shop memory",
    defaultOn: false,
    on: "The shop USSD screens offer the caller's remembered shop as option 1.",
    off: "The shop USSD screens no longer offer a remembered shop; callers type the shop code each time.",
    read: "Show whether the shop USSD code offers the caller's remembered shop.",
    set: "Turn USSD shop memory on or off.",
    scope: "Every caller of the shop USSD code, from now on.",
  },
  {
    id: "ussd_whitelist",
    path: "/api/admin/settings/ussd-whitelist",
    page: "/admin/settings",
    key: "ussd_data_whitelist_enabled",
    name: "USSD data whitelist",
    defaultOn: false,
    on: "USSD data bundle purchases are limited to registered users and whitelisted numbers; everyone else is refused.",
    off: "Anyone can buy data bundles on USSD.",
    read: "Show whether USSD data purchases are limited to registered users.",
    set: "Turn the USSD data whitelist on or off.",
    scope: "Every USSD caller buying data, from now on.",
  },
  {
    id: "strict_supplier_verify",
    path: "/api/admin/settings/strict-supplier-verify",
    page: "/admin/settings/mtn",
    key: "mtn_strict_supplier_verification",
    name: "Strict supplier verification",
    defaultOn: false,
    on: "An MTN order is only sent to a supplier that itself approved the number; a supplier that cannot check numbers gets no MTN orders and orders can be held.",
    off: "MTN orders are sent to suppliers without the per-supplier number approval.",
    read: "Show whether strict per-supplier MTN number verification is on, with warnings about suppliers that cannot check numbers.",
    set: "Turn strict supplier verification on or off. Turning it on is refused until its database tables exist.",
    scope: "Every MTN order placed from now on.",
    getKeep: ["enabled", "warnings"],
    method: "PUT",
  },
]

const toggleByPath = (path: string): Toggle => TOGGLES.find((t) => t.path === path)!

// ---------------------------------------------------------------------------------------------------------------------
// Direct MoMo charge switches (stored inside the payment gateway config)
// ---------------------------------------------------------------------------------------------------------------------

const GATEWAY_KEY = "payment_gateway_config"
const SURFACE_LABEL: Record<SurfaceKey, string> = {
  wallet_topup: "Wallet top-up",
  storefront: "Storefront (shop orders)",
  dashboard_direct: "Dashboard direct buying",
  sms: "SMS payment links",
  ussd: "USSD",
  whatsapp: "WhatsApp",
  sms_order: "Text-to-buy",
}

/** The saved gateway config, or null when none is saved / unreadable. Falls back like the app does (hosted checkout on web surfaces). */
async function readGateway(ctx: CardCtx): Promise<{ config: GatewayConfig; saved: boolean } | null> {
  const r = await adminSetting(ctx, GATEWAY_KEY)
  if (r.state === "unread") return null
  const base = deriveFromLegacy({ storefrontDirect: false, walletDirect: false })
  return { config: r.state === "found" ? sanitizeGatewayConfig(r.row.value, base) : base, saved: r.state === "found" }
}

function directChargeCard(name: string, surfaces: SurfaceKey[], effectOn: string, effectOff: string) {
  return async (i: EntryInput, ctx: CardCtx): Promise<Card> => {
    const next = asBody(i).enabled === true
    const to = next ? "direct" : "checkout"
    const g = await readGateway(ctx)
    const lines: CardLine[] = [{ label: "Setting", value: name }]
    if (!g) lines.push(UNREAD)
    for (const s of surfaces) {
      lines.push({ label: SURFACE_LABEL[s], value: g ? change(g.config.surfaces[s].mode, to) : `(unknown) -> ${to}` })
    }
    if (g && !g.saved) lines.push({ label: "Note", value: "No gateway settings are saved yet: the old value shown is the built-in default." })
    lines.push({ label: "What changes", value: next ? effectOn : effectOff })
    lines.push({ label: "Who is affected", value: "Every customer paying on those surfaces, from now on. The payment provider and fee settings are not touched." })
    return { summary: `Turn ${name} ${onOff(next)}`, lines }
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Provider lists (mirrors of the handlers' own lists)
// ---------------------------------------------------------------------------------------------------------------------

// lib/mtn-providers/factory.ts VALID_PROVIDERS
const MTN_PROVIDERS = ["sykes", "datakazina", "xpress", "eazyghdata", "bisdel", "codecraft", "agentportalgh", "apexprime", "bundleportal", "kuntanii", "hubnet"] as const
const mtnProvider = z.enum(MTN_PROVIDERS)
// lib/mtn-providers/provider-whitelist.ts WHITELIST_REGISTRY names
const CHECKING_PROVIDERS = ["xpress", "codecraft", "agentportalgh", "apexprime", "bundleportal", "kuntanii", "hubnet"] as const
// settings/network-provider VALID_PROVIDERS_BY_NETWORK and NETWORK_KEYS
const NETWORK_PROVIDERS = {
  telecel: ["datakazina", "xpress", "eazyghdata", "codecraft", "agentportalgh", "apexprime", "bundleportal", "spfastit_telecel", "hubnet"],
  at_ishare: ["datakazina", "xpress", "eazyghdata", "codecraft", "agentportalgh", "apexprime", "spfastit", "bundleportal", "hubnet"],
  at_bigtime: ["datakazina", "xpress", "eazyghdata", "codecraft", "bundleportal", "hubnet"],
} as const
const NETWORK_KEYS = { telecel: "telecel_provider_selection", at_ishare: "at_ishare_provider_selection", at_bigtime: "at_bigtime_provider_selection" } as const
const NETWORK_LABEL = { telecel: "Telecel", at_ishare: "AT iShare", at_bigtime: "AT BigTime" } as const
const allNetworkProviders = Array.from(new Set(Object.values(NETWORK_PROVIDERS).flat())) as [string, ...string[]]

// ---------------------------------------------------------------------------------------------------------------------
// settings PUT (the site-wide settings row)
// ---------------------------------------------------------------------------------------------------------------------

type FieldKind = "bool" | "pct" | "ghs" | "text" | "url" | "list" | "role" | "phone" | "tier" | "code"

const SITE_FIELDS: Array<{ key: string; label: string; kind: FieldKind; note?: (next: unknown) => string | null }> = [
  {
    key: "ordering_enabled",
    label: "Ordering",
    kind: "bool",
    note: (n) => (n === false ? "Customers cannot place orders at all (every page, bot and the API) until it is turned back ON." : "Ordering reopens for every customer."),
  },
  { key: "signups_enabled", label: "Signups", kind: "bool", note: (n) => (n === false ? "No new accounts can be created." : "New accounts can be created again.") },
  {
    key: "signup_default_role",
    label: "Role given at signup",
    kind: "role",
    note: (n) => (n === "dealer" ? "Every new signup becomes a dealer straight away (dealer prices) instead of a normal user." : "Every new signup becomes a normal user."),
  },
  { key: "wallet_topups_enabled", label: "Wallet top-ups", kind: "bool", note: (n) => (n === false ? "Nobody can top up their wallet." : "Wallet top-ups are allowed again.") },
  { key: "upgrades_enabled", label: "Dealer upgrades", kind: "bool", note: (n) => (n === false ? "Nobody can upgrade to dealer." : "Dealer upgrades are allowed again.") },
  { key: "announcement_enabled", label: "Announcement", kind: "bool", note: (n) => (n === true ? "The announcement is shown to signed-in users." : "The announcement is hidden.") },
  { key: "announcement_title", label: "Announcement title", kind: "text" },
  { key: "announcement_message", label: "Announcement message", kind: "text" },
  { key: "storefront_announcement_enabled", label: "Storefront announcement", kind: "bool", note: (n) => (n === true ? "The storefront announcement is shown on every shop." : "The storefront announcement is hidden.") },
  { key: "storefront_announcement_title", label: "Storefront announcement title", kind: "text" },
  { key: "storefront_announcement_message", label: "Storefront announcement message", kind: "text" },
  { key: "paystack_fee_percentage", label: "Paystack fee", kind: "pct" },
  { key: "wallet_topup_fee_percentage", label: "Wallet top-up fee", kind: "pct" },
  { key: "withdrawal_fee_percentage", label: "Withdrawal fee", kind: "pct" },
  { key: "withdrawal_fee_minimum", label: "Smallest withdrawal fee", kind: "ghs" },
  { key: "minimum_withdrawal_amount", label: "Smallest withdrawal", kind: "ghs" },
  { key: "price_adjustment_mtn", label: "MTN price adjustment", kind: "pct" },
  { key: "price_adjustment_telecel", label: "Telecel price adjustment", kind: "pct" },
  { key: "price_adjustment_at_ishare", label: "AT iShare price adjustment", kind: "pct" },
  { key: "price_adjustment_at_bigtime", label: "AT BigTime price adjustment", kind: "pct" },
  { key: "supplier_cost_per_gb_mtn", label: "MTN supplier cost per GB", kind: "ghs" },
  { key: "supplier_cost_per_gb_telecel", label: "Telecel supplier cost per GB", kind: "ghs" },
  { key: "supplier_cost_per_gb_at_ishare", label: "AT iShare supplier cost per GB", kind: "ghs" },
  { key: "supplier_cost_per_gb_at_bigtime", label: "AT BigTime supplier cost per GB", kind: "ghs" },
  { key: "join_community_link", label: "Community link", kind: "url" },
  { key: "join_group_link", label: "Group link", kind: "url" },
  { key: "whatsapp_bot_number", label: "WhatsApp bot number", kind: "phone" },
  { key: "ai_widget_services", label: "Services shown in the chat widget", kind: "list" },
  { key: "ussd_price_tier", label: "USSD price tier", kind: "tier", note: (n) => `USSD purchases are charged at ${String(n)} prices.` },
  { key: "ussd_shop_dial_code", label: "Shop USSD code", kind: "code" },
  { key: "ussd_shop_activation_fee", label: "USSD shop activation fee", kind: "ghs" },
  { key: "whatsapp_shop_activation_fee", label: "WhatsApp shop activation fee", kind: "ghs" },
  { key: "storefront_show_ussd_card", label: "USSD card on storefronts", kind: "bool" },
  { key: "sub_agent_open_join_enabled", label: "Open sub-agent join", kind: "bool", note: (n) => (n === true ? "Sub-agents can join a shop without the owner approving each one." : "Sub-agents need the owner's approval to join.") },
]

function fmt(kind: FieldKind, v: unknown): string {
  if (v === undefined || v === null) return "(not set)"
  switch (kind) {
    case "bool":
      return onOff(v === true)
    case "pct":
      return pct(v)
    case "ghs":
      return ghs2(v)
    case "list":
      return list(v)
    case "phone": {
      const s = str(v)
      if (!s.trim()) return "(empty)"
      return s
    }
    default:
      return shown(v)
  }
}

/** What the handler stores for the bot number: "233" + the nine digits, or "" to clear. null = refused. */
function storedBotNumber(raw: string): string | null {
  if (raw.trim() === "") return ""
  const sig = ghanaSignificant(raw)
  return sig ? `233${sig}` : null
}

async function siteSettingsCard(i: EntryInput, ctx: CardCtx): Promise<Card> {
  const b = asBody(i)
  const sent = SITE_FIELDS.filter((f) => b[f.key] !== undefined)
  const lines: CardLine[] = []
  if (sent.length === 0) {
    lines.push({ label: "Problem", value: "Nothing to change: no setting was sent, so only the saved-at time would change. The request is pointless." })
    return { summary: "Change the site settings", lines }
  }
  const cur = await appSingleton(ctx, sent.map((f) => f.key).join(", "))
  const old = cur.state === "found" ? cur.row : null
  if (cur.state === "unread") lines.push({ label: "Problem", value: "The current site settings could not be read just now, so the old values cannot be shown." })
  if (cur.state === "missing") lines.push({ label: "Note", value: "No site settings row is saved yet: it is created with the built-in defaults plus these changes." })
  for (const f of sent) {
    let next = b[f.key]
    if (f.kind === "phone") {
      const stored = storedBotNumber(str(next))
      if (stored === null) {
        lines.push({ label: f.label, value: `"${str(next)}" is not a valid Ghana mobile number: the request is refused.` })
        continue
      }
      next = stored
    }
    const before = cur.state === "unread" ? "(unknown)" : fmt(f.kind, old ? old[f.key] : undefined)
    lines.push({ label: f.label, value: change(before, fmt(f.kind, next)) })
    const n = f.note?.(next)
    if (n) lines.push({ label: `${f.label}: effect`, value: n })
  }
  const adjusted = ["price_adjustment_mtn", "price_adjustment_telecel", "price_adjustment_at_ishare", "price_adjustment_at_bigtime"].some((k) => b[k] !== undefined)
  if (adjusted) lines.push({ label: "Prices", value: "A price adjustment changes what customers pay for that network's bundles on every page, and the public price pages refresh." })
  if (b.ussd_shop_dial_code !== undefined) lines.push({ label: "Public pages", value: "The shop USSD code is shown on the public USSD page and in the site's text for search engines and assistants." })
  const feeKeys = ["paystack_fee_percentage", "wallet_topup_fee_percentage", "withdrawal_fee_percentage", "withdrawal_fee_minimum", "minimum_withdrawal_amount", "supplier_cost_per_gb_mtn", "supplier_cost_per_gb_telecel", "supplier_cost_per_gb_at_ishare", "supplier_cost_per_gb_at_bigtime", "ussd_shop_activation_fee", "whatsapp_shop_activation_fee"]
  if (feeKeys.some((k) => b[k] !== undefined)) lines.push({ label: "Money", value: "Fees, minimums and costs apply to every new payment, withdrawal and profit calculation from now on; amounts already recorded are not changed." })
  lines.push({ label: "Who is affected", value: "The whole site, immediately. Nothing is sent to customers." })
  return { summary: "Change the site settings", lines }
}

const url500 = z.string().max(500).refine((v) => {
  if (v === "") return true
  try {
    const u = new URL(v)
    return u.protocol === "https:" || u.protocol === "http:"
  } catch {
    return false
  }
}, "must be an http or https link, or empty to clear")

const siteBody = z
  .object({
    ordering_enabled: bool.optional(),
    signups_enabled: bool.optional(),
    signup_default_role: z.enum(["user", "dealer"]).optional(),
    wallet_topups_enabled: bool.optional(),
    upgrades_enabled: bool.optional(),
    announcement_enabled: bool.optional(),
    announcement_title: z.string().max(200).optional(),
    announcement_message: z.string().max(1000).optional(),
    storefront_announcement_enabled: bool.optional(),
    storefront_announcement_title: z.string().max(200).optional(),
    storefront_announcement_message: z.string().max(1000).optional(),
    paystack_fee_percentage: z.number().min(0).max(100).optional(),
    wallet_topup_fee_percentage: z.number().min(0).max(100).optional(),
    withdrawal_fee_percentage: z.number().min(0).max(100).optional(),
    withdrawal_fee_minimum: z.number().min(0).max(100000).optional(),
    minimum_withdrawal_amount: z.number().min(0).max(100000).optional(),
    price_adjustment_mtn: z.number().min(-100).max(500).optional(),
    price_adjustment_telecel: z.number().min(-100).max(500).optional(),
    price_adjustment_at_ishare: z.number().min(-100).max(500).optional(),
    price_adjustment_at_bigtime: z.number().min(-100).max(500).optional(),
    supplier_cost_per_gb_mtn: z.number().min(0).max(100000).optional(),
    supplier_cost_per_gb_telecel: z.number().min(0).max(100000).optional(),
    supplier_cost_per_gb_at_ishare: z.number().min(0).max(100000).optional(),
    supplier_cost_per_gb_at_bigtime: z.number().min(0).max(100000).optional(),
    join_community_link: url500.optional(),
    join_group_link: url500.optional(),
    whatsapp_bot_number: z.string().max(20).refine((v) => v.trim() === "" || ghanaSignificant(v) !== null, "must be a Ghana mobile number, or empty to clear").optional(),
    ai_widget_services: z.array(z.string().min(1).max(40)).max(10).optional(),
    ussd_price_tier: z.enum(["regular", "dealer"]).optional(),
    ussd_shop_dial_code: z.string().max(30).refine((v) => v === "" || USSD_CODE_RE.test(v), "must look like *426*203#").optional(),
    ussd_shop_activation_fee: z.number().min(0).max(100000).optional(),
    whatsapp_shop_activation_fee: z.number().min(0).max(100000).optional(),
    storefront_show_ussd_card: bool.optional(),
    sub_agent_open_join_enabled: bool.optional(),
  })
  .strict()

// ---------------------------------------------------------------------------------------------------------------------
// Provider, gate and list cards
// ---------------------------------------------------------------------------------------------------------------------

async function afaProviderCard(i: EntryInput, ctx: CardCtx): Promise<Card> {
  const next = str(asBody(i).provider)
  const r = await adminSetting(ctx, "afa_provider_selection")
  const old = r.state === "unread" ? null : str(valueOf(r)?.provider) || "sykes"
  const lines: CardLine[] = [
    { label: "Setting", value: "Who handles new AFA registrations" },
    { label: "Provider", value: change(old ?? "(unknown)", next) },
    { label: "What changes", value: next === "apexprime" ? "New AFA registrations go to Apex Prime, which is paid from the wallet at the supplier and confirmed later by a background job." : "New AFA registrations go to Sykes, which answers straight away." },
    { label: "Who is affected", value: "Every AFA registration from now on (ones already sent stay with their supplier)." },
  ]
  if (r.state === "unread") lines.push(UNREAD)
  return { summary: `Send AFA registrations to ${next}`, lines }
}

async function mtnProviderCard(i: EntryInput, ctx: CardCtx): Promise<Card> {
  const next = str(asBody(i).provider)
  const r = await adminSetting(ctx, "mtn_provider_selection")
  const old = r.state === "unread" ? "(unknown)" : str(valueOf(r)?.provider) || "sykes"
  const lines: CardLine[] = [
    { label: "Setting", value: "Main MTN supplier" },
    { label: "Provider", value: change(old, next) },
    { label: "What changes", value: `All new MTN orders are sent to ${next} first. If it is deactivated the system uses the first active supplier instead; the retry list still applies when a send fails.` },
    { label: "Who is affected", value: "Every MTN order placed from now on (orders already sent stay where they are)." },
  ]
  if (r.state === "unread") lines.push(UNREAD)
  return { summary: `Make ${next} the main MTN supplier`, lines }
}

async function mtnDisabledCard(i: EntryInput, ctx: CardCtx): Promise<Card> {
  const next = (asBody(i).disabled as string[]) ?? []
  const r = await adminSetting(ctx, "mtn_disabled_providers")
  const lines: CardLine[] = []
  if (r.state === "unread") {
    lines.push(UNREAD, { label: "Deactivated after this", value: list(next) })
  } else {
    const oldList = (Array.isArray(valueOf(r)?.providers) ? (valueOf(r)!.providers as unknown[]) : []).map(String)
    lines.push(
      { label: "Deactivated now", value: list(oldList) },
      { label: "Deactivated after this", value: list(next) },
      { label: "Newly deactivated", value: list(next.filter((p) => !oldList.includes(p))) },
      { label: "Reactivated", value: list(oldList.filter((p) => !next.includes(p))) },
    )
  }
  lines.push(
    { label: "What changes", value: "A deactivated supplier is skipped when the system picks the main supplier or works through the retry list. A manual retry to it by an admin still works." },
    { label: "Who is affected", value: "Every MTN order placed from now on." },
  )
  return { summary: "Change which MTN suppliers are deactivated", lines }
}

async function mtnRetryCard(i: EntryInput, ctx: CardCtx): Promise<Card> {
  const b = asBody(i)
  const enabled = b.enabled === true
  const providers = (b.providers as string[]) ?? []
  const r = await adminSetting(ctx, "mtn_retry_sequence")
  const v = valueOf(r)
  const lines: CardLine[] = [
    { label: "Retry on another supplier", value: r.state === "unread" ? `(unknown) -> ${onOff(enabled)}` : change(onOff(v?.enabled === true), onOff(enabled)) },
    { label: "Order of suppliers", value: r.state === "unread" ? providers.join(", ") || "none" : change(list(v?.providers), list(providers)) },
    { label: "What changes", value: enabled ? "When a send to the main supplier fails, the order is tried on these suppliers in this order." : "A failed send is not retried on another supplier automatically." },
    { label: "Who is affected", value: "Every MTN order placed from now on." },
  ]
  if (r.state === "unread") lines.push(UNREAD)
  if (enabled && providers.length === 0) lines.push({ label: "Note", value: "The list is empty, so there is nothing to retry on." })
  return { summary: "Change the MTN retry order", lines }
}

async function networkProviderCard(i: EntryInput, ctx: CardCtx): Promise<Card> {
  const b = asBody(i)
  const network = str(b.network) as keyof typeof NETWORK_KEYS
  const next = str(b.provider)
  const lines: CardLine[] = []
  if (!NETWORK_KEYS[network]) return { summary: "Change a network's supplier", lines: [{ label: "Problem", value: "Unknown network: refused." }] }
  const r = await adminSetting(ctx, NETWORK_KEYS[network])
  const old = r.state === "unread" ? "(unknown)" : str(valueOf(r)?.provider) || "codecraft"
  lines.push(
    { label: "Network", value: NETWORK_LABEL[network] },
    { label: "Supplier", value: change(old, next) },
    { label: "What changes", value: `All new ${NETWORK_LABEL[network]} orders are sent to ${next}.` },
    { label: "Who is affected", value: `Every ${NETWORK_LABEL[network]} order placed from now on (orders already sent stay where they are).` },
  )
  if (!(NETWORK_PROVIDERS[network] as readonly string[]).includes(next)) lines.push({ label: "Problem", value: `${next} is not allowed for ${NETWORK_LABEL[network]}: the request is refused.` })
  if (r.state === "unread") lines.push(UNREAD)
  return { summary: `Send ${NETWORK_LABEL[network]} orders to ${next}`, lines }
}

function sanitizePrefixMap(raw: unknown): NetworkPrefixMap {
  const out: NetworkPrefixMap = { MTN: [...DEFAULT_NETWORK_PREFIXES.MTN], TELECEL: [...DEFAULT_NETWORK_PREFIXES.TELECEL], AT: [...DEFAULT_NETWORK_PREFIXES.AT] }
  if (raw && typeof raw === "object") {
    for (const net of ["MTN", "TELECEL", "AT"] as const) {
      const v = (raw as Obj)[net]
      if (Array.isArray(v)) {
        const cleaned = v.map(String).filter((p) => /^[2-9]\d$/.test(p))
        if (cleaned.length > 0) out[net] = cleaned
      }
    }
  }
  return out
}

async function prefixCard(i: EntryInput, ctx: CardCtx): Promise<Card> {
  const b = asBody(i)
  const network = str(b.network) as "MTN" | "TELECEL" | "AT"
  const action = str(b.action)
  const raw = str(b.prefix).trim()
  const sig = /^0\d{2}$/.test(raw) ? raw.slice(1) : raw
  const r = await adminSetting(ctx, "network_prefix_map")
  const lines: CardLine[] = [
    { label: "Network", value: network },
    { label: "Prefix", value: `0${sig}` },
    { label: "Action", value: action === "add" ? `Add 0${sig} to ${network}` : `Remove 0${sig} from ${network}` },
  ]
  if (r.state === "unread") {
    lines.push(UNREAD)
  } else {
    const map = sanitizePrefixMap(r.state === "found" ? r.row.value : undefined)
    lines.push({ label: `${network} prefixes now`, value: map[network].map((p) => `0${p}`).join(", ") })
    const owner = (["MTN", "TELECEL", "AT"] as const).find((n) => map[n].includes(sig))
    if (action === "add") {
      if (owner && owner !== network) lines.push({ label: "Problem", value: `Prefix 0${sig} is already assigned to ${owner}: remove it there first. The request is refused.` })
      else if (owner === network) lines.push({ label: "Note", value: `0${sig} is already on ${network}: nothing changes.` })
      else lines.push({ label: `${network} prefixes after`, value: [...map[network], sig].map((p) => `0${p}`).join(", ") })
    } else if (!map[network].includes(sig)) {
      lines.push({ label: "Problem", value: `Prefix 0${sig} is not assigned to ${network}: the request is refused.` })
    } else if (map[network].length === 1) {
      lines.push({ label: "Problem", value: `Cannot remove the last ${network} prefix: the request is refused.` })
    } else {
      lines.push({ label: `${network} prefixes after`, value: map[network].filter((p) => p !== sig).map((p) => `0${p}`).join(", ") })
    }
  }
  lines.push(
    { label: "What changes", value: "Which network a phone number belongs to, for the order-time network check and for the database's MTN number test used by registry exports. It applies at once to every order." },
    { label: "Record", value: "An entry is written to the admin audit log." },
  )
  return { summary: `${action === "add" ? "Add" : "Remove"} prefix 0${sig} ${action === "add" ? "to" : "from"} ${network}`, lines }
}

const BLOCKED_DEFAULTS = { enabled: false, customer_sms_enabled: false, retention_days: 30, spike_threshold_per_hour: 25, daily_sms_ceiling: 300 }

async function blockedCard(i: EntryInput, ctx: CardCtx): Promise<Card> {
  const b = asBody(i)
  const r = await adminSetting(ctx, "blocked_numbers_settings")
  const v = r.state === "unread" ? null : { ...BLOCKED_DEFAULTS, ...(valueOf(r) ?? {}) }
  const lines: CardLine[] = []
  const rows: Array<[string, string, (x: unknown) => string]> = [
    ["enabled", "Blocked number tracking", (x) => onOff(x === true)],
    ["customer_sms_enabled", "SMS to customers when their number is allowed again", (x) => onOff(x === true)],
    ["retention_days", "Keep records for", (x) => `${num(x)} days`],
    ["spike_threshold_per_hour", "Alert when blocked numbers per hour reach", (x) => num(x)],
    ["daily_sms_ceiling", "Most customer SMS per day", (x) => num(x)],
  ]
  let sent = 0
  for (const [k, label, f] of rows) {
    if (b[k] === undefined) continue
    sent++
    lines.push({ label, value: change(v ? f((v as Obj)[k]) : "(unknown)", f(b[k])) })
  }
  if (sent === 0) lines.push({ label: "Problem", value: "Nothing to change: no setting was sent." })
  if (r.state === "unread") lines.push(UNREAD)
  if (b.customer_sms_enabled === true) lines.push({ label: "Messages", value: "Customers get an SMS when a number that was blocked at MTN becomes allowed again, up to the daily ceiling." })
  lines.push({ label: "Who is affected", value: "Every MTN number check and the customers whose numbers are tracked, from now on. Settings you did not send keep their stored values." })
  return { summary: "Change the blocked-number tracking settings", lines }
}

async function customerVerificationCard(i: EntryInput, ctx: CardCtx): Promise<Card> {
  const b = asBody(i)
  const enabled = b.enabled === true
  const providers = (b.providers as string[]) ?? []
  const r = await adminSetting(ctx, "customer_verification_settings")
  const v = valueOf(r)
  const blockNext = b.block_unverified === undefined ? (r.state === "unread" ? undefined : v?.block_unverified === true) : b.block_unverified === true
  const lines: CardLine[] = [
    { label: "Live number check at checkout", value: r.state === "unread" ? `(unknown) -> ${onOff(enabled)}` : change(onOff(v?.enabled === true), onOff(enabled)) },
    { label: "Suppliers asked, in order", value: r.state === "unread" ? list(providers) : change(list(v?.providers), list(providers)) },
    {
      label: "Block numbers a supplier rejects",
      value: blockNext === undefined ? "(unknown)" : r.state === "unread" ? onOff(blockNext) : change(onOff(v?.block_unverified === true), onOff(blockNext)),
    },
    {
      label: "What changes",
      value: enabled
        ? blockNext
          ? "At checkout the number is checked with these suppliers and an order for a number they reject is BLOCKED, not just warned about."
          : "At checkout the number is checked with these suppliers and the customer sees a warning if they reject it; the order can still go ahead."
        : "No live number check at checkout.",
    },
    { label: "Who is affected", value: "Every customer at checkout on the pages that show the check, from now on." },
  ]
  if (r.state === "unread") lines.push(UNREAD)
  if (enabled && providers.length === 0) lines.push({ label: "Note", value: "No supplier is listed, so the check does nothing." })
  lines.push({ label: "Note", value: "A supplier that is not set up on the server is refused by the route." })
  return { summary: "Change the live number check at checkout", lines }
}

async function balanceThresholdCard(i: EntryInput, ctx: CardCtx): Promise<Card> {
  const next = asBody(i).threshold
  const r = await appKeyValue(ctx, "mtn_balance_alert_threshold")
  const old = r.state === "unread" ? "(unknown)" : ghs0(r.state === "found" ? parseInt(String(r.row.value), 10) || 500 : 500)
  const lines: CardLine[] = [
    { label: "MTN balance alert level", value: change(old, ghs0(next)) },
    { label: "What changes", value: "The balance at which the low-balance alert for the MTN supplier wallet fires. Nothing is paid or sent now." },
  ]
  if (r.state === "unread") lines.push(UNREAD)
  if (r.state === "missing") lines.push({ label: "Note", value: "Nothing was saved before: the old value is the built-in 500." })
  return { summary: "Change the MTN low-balance alert level", lines }
}

async function reviewUrlCard(i: EntryInput, ctx: CardCtx): Promise<Card> {
  const raw = asBody(i).url
  const v = validateReviewUrl(raw)
  const r = await appKeyValue(ctx, "google_review_url")
  let old = "(unknown)"
  if (r.state === "missing") old = "(not set)"
  if (r.state === "found") {
    try {
      const o = JSON.parse(String(r.row.value)) as { url?: unknown }
      old = typeof o.url === "string" && o.url ? o.url : "(not set)"
    } catch {
      old = "(not set)"
    }
  }
  const next = v.ok ? (v.value ?? "(cleared)") : str(raw)
  const lines: CardLine[] = [
    { label: "Google review link", value: change(old, next) },
    { label: "What changes", value: "The review link shown to customers in the review prompt." },
  ]
  if (!v.ok) lines.push({ label: "Problem", value: v.error })
  if (r.state === "unread") lines.push(UNREAD)
  return { summary: "Change the Google review link", lines }
}

async function ussdCodeCard(i: EntryInput, ctx: CardCtx): Promise<Card> {
  const raw = asBody(i).main
  const r = await appKeyValue(ctx, "public_ussd_codes")
  let old = "(unknown)"
  if (r.state === "missing") old = "(not set)"
  if (r.state === "found") {
    try {
      const o = JSON.parse(String(r.row.value)) as { main?: unknown }
      old = typeof o.main === "string" && o.main ? o.main : "(not set)"
    } catch {
      old = "(not set)"
    }
  }
  const next = raw === null || raw === "" ? "(cleared)" : str(raw)
  const lines: CardLine[] = [
    { label: "Main USSD code shown to the public", value: change(old, next) },
    { label: "What changes", value: "The code customers are told to dial on the public site and in the text assistants read. Customers who dial a wrong code reach someone else, so check it is ours." },
    { label: "Who is affected", value: "Every visitor of the public site, on the next page refresh." },
  ]
  if (r.state === "unread") lines.push(UNREAD)
  return { summary: "Change the public USSD code", lines }
}

const normalisePhone = (raw: string): string => {
  const cleaned = raw.replace(/[\s\-()]/g, "")
  if (cleaned.startsWith("+233") && cleaned.length === 13) return "0" + cleaned.slice(4)
  if (cleaned.startsWith("233") && cleaned.length === 12) return "0" + cleaned.slice(3)
  if (cleaned.startsWith("0") && cleaned.length === 10) return cleaned
  if (/^\d{9}$/.test(cleaned)) return "0" + cleaned
  return cleaned
}

async function whitelistAddCard(i: EntryInput, ctx: CardCtx): Promise<Card> {
  const numbers = ((asBody(i).numbers as string[]) ?? []).map((n) => String(n).trim())
  const valid = Array.from(new Set(numbers.map(normalisePhone).filter((n) => /^0\d{9}$/.test(n))))
  const dropped = numbers.length - valid.length
  const lines: CardLine[] = []
  if (valid.length === 0) {
    lines.push({ label: "Problem", value: "No valid Ghana phone numbers were found: the request is refused." })
    return { summary: "Add numbers to the USSD whitelist", lines }
  }
  const already = await readRows(() => ctx.db.from("ussd_whitelist").select("phone_number").in("phone_number", valid))
  lines.push(
    { label: "Numbers to add", value: valid.join(", ") },
    { label: "Count", value: String(valid.length) },
    { label: "Ignored", value: `${dropped} ${dropped === 1 ? "entry" : "entries"} ignored (not a valid Ghana number, or a repeat of another).` },
    { label: "Already on the list", value: already ? String(already.length) : "unknown (could not be read)" },
    { label: "What changes", value: "These numbers may buy data on USSD while the data whitelist is ON. Nothing is sent to them." },
  )
  return { summary: `Add ${valid.length} number${valid.length === 1 ? "" : "s"} to the USSD whitelist`, lines }
}

async function whitelistRemoveCard(i: EntryInput, ctx: CardCtx): Promise<Card> {
  const phone = normalisePhone(str(asBody(i).phone_number).trim())
  const lines: CardLine[] = []
  if (!phone) return { summary: "Remove a number from the USSD whitelist", lines: [{ label: "Problem", value: "A phone number is required: the request is refused." }] }
  const there = await readOne(() => ctx.db.from("ussd_whitelist").select("phone_number").eq("phone_number", phone).maybeSingle())
  const sw = await adminSetting(ctx, "ussd_data_whitelist_enabled")
  const swOn = sw.state === "unread" ? null : enabledOf(valueOf(sw), false)
  lines.push(
    { label: "Number", value: phone },
    { label: "On the list now", value: there.state === "unread" ? "unknown (could not be read)" : there.state === "found" ? "yes" : "no (nothing is removed)" },
    { label: "Whitelist switch", value: swOn === null ? "unknown" : onOff(swOn) },
    { label: "What changes", value: `This number will be blocked from USSD data purchases while the whitelist switch is ON${swOn === false ? " (it is OFF now, so nothing is blocked yet)" : ""}. Callers whose number is not on the list and who are not registered users are refused.` },
  )
  return { summary: "Remove a number from the USSD whitelist", lines }
}

// ---------------------------------------------------------------------------------------------------------------------
// Payment gateway
// ---------------------------------------------------------------------------------------------------------------------

const surfaceSchema = z.object({ gateway: z.enum(["paystack", "hubtel"]), mode: z.enum(["checkout", "direct"]), feeBearer: z.enum(["customer", "merchant"]) }).strict()
const directOnly = z.object({ gateway: z.enum(["paystack", "hubtel"]), mode: z.literal("direct"), feeBearer: z.enum(["customer", "merchant"]) }).strict()

const gatewayBody = z
  .object({
    config: z
      .object({
        version: z.literal(1).optional(),
        surfaces: z
          .object({
            wallet_topup: surfaceSchema,
            storefront: surfaceSchema,
            dashboard_direct: surfaceSchema,
            sms: surfaceSchema,
            ussd: directOnly,
            whatsapp: directOnly,
            sms_order: directOnly,
          })
          .strict(),
        hubtelFeePercent: z.number().min(0).max(100),
      })
      .strict(),
  })
  .strict()

async function gatewayCard(i: EntryInput, ctx: CardCtx): Promise<Card> {
  const next = asBody(i).config as GatewayConfig
  const g = await readGateway(ctx)
  const lines: CardLine[] = []
  if (!g) {
    lines.push(UNREAD)
    for (const k of SURFACE_KEYS) {
      const s = next.surfaces[k]
      lines.push({ label: SURFACE_LABEL[k], value: `(unknown) -> ${s.gateway}, ${s.mode}, fee paid by ${s.feeBearer}` })
    }
  } else {
    let changed = 0
    for (const k of SURFACE_KEYS) {
      const a = g.config.surfaces[k]
      const b = next.surfaces[k]
      const parts: string[] = []
      if (a.gateway !== b.gateway) parts.push(`provider ${change(a.gateway, b.gateway)}`)
      if (a.mode !== b.mode) parts.push(`mode ${change(a.mode, b.mode)}`)
      if (a.feeBearer !== b.feeBearer) parts.push(`fee paid by ${change(a.feeBearer, b.feeBearer)}`)
      if (parts.length > 0) {
        changed++
        lines.push({ label: SURFACE_LABEL[k], value: parts.join("; ") })
      }
    }
    if (g.config.hubtelFeePercent !== next.hubtelFeePercent) {
      changed++
      lines.push({ label: "Hubtel fee", value: change(pct(g.config.hubtelFeePercent), pct(next.hubtelFeePercent)) })
    }
    if (changed === 0) lines.push({ label: "Note", value: "Nothing differs from what is saved: saving changes nothing." })
    if (!g.saved) lines.push({ label: "Note", value: "No gateway settings are saved yet: the old values shown are the built-in defaults (hosted checkout, Paystack)." })
  }
  const usesHubtel = SURFACE_KEYS.some((k) => next.surfaces[k].gateway === "hubtel")
  if (usesHubtel) {
    lines.push({
      label: "Hubtel",
      value: isHubtelCollectionReady()
        ? "Customers on the surfaces above will pay through Hubtel."
        : "Hubtel is not set up on the server, so the request is refused while any surface uses it.",
    })
  }
  lines.push(
    { label: "Fees", value: "The fee setting decides whether the customer or Datagod pays the payment provider's charge on each surface." },
    { label: "Who is affected", value: "Every customer paying on the surfaces that changed, within about 30 seconds. Payments already started finish where they began." },
  )
  return { summary: "Change the payment gateway settings", lines }
}

const hubtelBody = z
  .object({
    action: z.enum(["recheck", "check_manual_refund", "fulfil", "mark_failed", "refunded_manually"]),
    reference: z.string().regex(/^[0-9a-f]{32}$/),
    admin_reference: z.string().min(4).max(100).regex(/^[^\u0000-\u001f\u007f]*$/).optional(),
    note: z.string().min(3).max(500).optional(),
  })
  .strict()

async function hubtelCard(i: EntryInput, ctx: CardCtx): Promise<Card> {
  const b = asBody(i)
  const action = str(b.action)
  const reference = str(b.reference)
  const r = await readOne(() => ctx.db.from("hubtel_payments").select("reference, surface, amount_pesewas, status").eq("reference", reference).maybeSingle())
  const lines: CardLine[] = [{ label: "Payment reference", value: reference }]
  if (r.state === "found") {
    lines.push(
      { label: "Amount requested", value: ghs2(Number(r.row.amount_pesewas) / 100) },
      { label: "Where it was made", value: str(r.row.surface) || "unknown" },
      { label: "Status now", value: str(r.row.status) || "unknown" },
    )
  } else if (r.state === "missing") {
    lines.push({ label: "Problem", value: "No Hubtel payment with this reference was found: the request is refused." })
  } else {
    lines.push({ label: "Problem", value: "The payment could not be read just now, so its amount and status cannot be shown." })
  }
  if (action !== "refunded_manually" && (b.admin_reference !== undefined || b.note !== undefined)) lines.push({ label: "Problem", value: "A reference and note only belong to the refunded-outside-the-app action: the request is refused." })
  switch (action) {
    case "recheck":
    case "check_manual_refund":
      lines.push({ label: "What this does", value: `Asks Hubtel for the payment's current status${action === "check_manual_refund" ? " and whether it qualifies as a second payment you can record as refunded" : ""}. Writes nothing: no money moves and nothing is changed.` })
      break
    case "fulfil":
      lines.push(
        { label: "What this does", value: "Asks Hubtel for a fresh status. Only if it says Paid by mobile money or wallet and Hubtel received at least the amount requested, it completes the order or top-up as if the payment had just arrived: the goods are delivered or the wallet is credited, the usual notices go out, and the payment is marked paid." },
        { label: "Refused when", value: "Hubtel does not say Paid, the amount is short, or another payment already settled the order (a second payment: pay it back by hand and record it instead)." },
        { label: "Cannot be undone", value: "A delivery or wallet credit already made is not reversed by this tool." },
      )
      break
    case "mark_failed":
      lines.push(
        { label: "What this does", value: "After a fresh check that does not say Paid, closes this Hubtel payment record as failed and closes its pending wallet payment. The order itself is not changed." },
        { label: "Refused when", value: "Hubtel says the payment is Paid (money is held) or the check fails." },
      )
      break
    case "refunded_manually": {
      const ref = b.admin_reference === undefined ? "(missing: the request is refused)" : str(b.admin_reference)
      const note = b.note === undefined ? "(missing: the request is refused)" : str(b.note)
      lines.push(
        { label: "Your MoMo or Hubtel reference", value: ref },
        { label: "Your note", value: note },
        { label: "What this does", value: "Records that you already paid this second payment back to the customer outside the app. No money moves and the order is not changed. The payment record is closed for good and the first payment becomes refundable again." },
        { label: "Refused when", value: "Hubtel does not say Paid, or nothing else shows as paid for the order (this may be its only payment: use fulfil instead)." },
        { label: "Record", value: "An entry with your admin id and the payment reference is written to the admin audit log." },
      )
      break
    }
    default:
      lines.push({ label: "Problem", value: "Unknown action: the request is refused." })
  }
  return { summary: `Hubtel payment: ${action.replace(/_/g, " ")}`, lines }
}

// ---------------------------------------------------------------------------------------------------------------------
// delivery channels, christmas theme, rate limits
// ---------------------------------------------------------------------------------------------------------------------

const DELIVERY_CHANNELS = { mtn: "MTN", telecel: "Telecel", at_ishare: "AT - iShare", at_bigtime: "AT - BigTime", utility: "Utility Bills", standard: "Standard Bundles" } as const

async function deliveryCard(i: EntryInput, ctx: CardCtx): Promise<Card> {
  const b = asBody(i)
  const channel = str(b.channel) as keyof typeof DELIVERY_CHANNELS
  const down = b.down === true
  const label = DELIVERY_CHANNELS[channel] ?? channel
  const r = await readOne(() => ctx.db.from("delivery_channel_overrides").select("channel, is_manually_down, reason").eq("channel", channel).maybeSingle())
  const old = r.state === "unread" ? "(unknown)" : r.state === "found" && r.row.is_manually_down === true ? "marked down" : "normal"
  const reason = typeof b.reason === "string" && b.reason.trim() ? b.reason.trim().slice(0, 200) : null
  const lines: CardLine[] = [
    { label: "Channel", value: label },
    { label: "Status", value: change(old, down ? "marked down" : "normal") },
  ]
  if (down) {
    lines.push(
      { label: "Reason shown", value: reason ?? "(none given)" },
      { label: "What changes", value: "The channel shows as down on the delivery-time display, and the delivery numbers are frozen at what they are now instead of updating. Ordering is not blocked." },
    )
  } else {
    lines.push({ label: "What changes", value: "The channel goes back to normal and its delivery numbers update live again. The old reason is cleared." })
  }
  lines.push({ label: "Who is affected", value: "Every customer looking at delivery times." })
  if (r.state === "unread") lines.push(UNREAD)
  return { summary: `${down ? "Mark" : "Restore"} the ${label} delivery channel ${down ? "down" : "to normal"}`, lines }
}

async function christmasCard(i: EntryInput, ctx: CardCtx): Promise<Card> {
  const next = asBody(i).christmas_theme_enabled === true
  const r = await appSingleton(ctx, "christmas_theme_enabled")
  const old = r.state === "unread" ? "(unknown)" : onOff(r.state === "found" && r.row.christmas_theme_enabled === true)
  const lines: CardLine[] = [
    { label: "Christmas theme", value: change(old, onOff(next)) },
    { label: "What changes", value: next ? "Every visitor sees the Christmas look on the site." : "The Christmas look is removed for everyone." },
  ]
  if (r.state === "unread") lines.push(UNREAD)
  return { summary: `Turn the Christmas theme ${onOff(next)}`, lines }
}

async function rateResetCard(i: EntryInput, ctx: CardCtx): Promise<Card> {
  const b = asBody(i)
  const endpoint = str(b.endpoint)
  const identifier = str(b.identifier)
  let count: number | null = null
  try {
    const { count: c, error } = (await ctx.db.from("rate_limit_blocks").select("id", { count: "exact", head: true }).eq("endpoint", endpoint).eq("identifier", identifier)) as { count?: number | null; error?: unknown }
    if (!error && typeof c === "number") count = c
  } catch {
    count = null
  }
  return {
    summary: "Clear a rate limit",
    lines: [
      { label: "Endpoint", value: endpoint },
      { label: "Who or what is limited", value: identifier },
      { label: "Block records", value: count === null ? "could not be counted just now" : `${count} logged block ${count === 1 ? "record" : "records"} will be deleted` },
      { label: "What changes", value: "The live rate-limit counter for this endpoint and identifier is deleted, so the caller can try again straight away. It stops protecting that endpoint from this caller until it fills up again." },
      { label: "Check first", value: "If this is an attacker's address or a number that is being abused, do not clear it." },
      { label: "Needs", value: "The rate-limit store (Upstash) to be set up; otherwise the request is refused." },
    ],
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// custom domains
// ---------------------------------------------------------------------------------------------------------------------

const DOMAIN_SERVICES = ["data_bundles", "airtime", "results_checker", "bulk_sms"] as const
const PAGE_KEYS = TOGGLEABLE_PAGES.map((p) => p.key) as [string, ...string[]]
const ROOT_DOMAIN = (process.env.NEXT_PUBLIC_ROOT_DOMAIN || "datagod.store").toLowerCase()
const normaliseDomain = (raw: string): string => raw.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/+$/, "")

const domainName = z.string().min(3).max(253).refine((v) => {
  const d = normaliseDomain(v)
  return d.includes(".") && /^[a-z0-9.-]+$/.test(d)
}, "must be a domain like shop.example.com")
const httpsUrl = z.string().max(500).refine((v) => v === "" || /^https:\/\/\S+$/.test(v), "must be an https link, or empty to clear")
const colorText = z.string().max(20).refine((v) => v === "" || /^#[0-9a-fA-F]{3,8}$/.test(v), "must be a hex color like #1a2b3c, or empty to clear")

async function shopLine(ctx: CardCtx, id: string): Promise<{ text: string; ok: boolean }> {
  const r = await readOne(() => ctx.db.from("user_shops").select("id, shop_name, subdomain, is_active, is_blocked").eq("id", id).maybeSingle())
  if (r.state === "unread") return { text: `shop ${id} (could not be read)`, ok: true }
  if (r.state === "missing") return { text: `No shop with id ${id}: the request is refused.`, ok: false }
  const active = r.row.is_active === true && r.row.is_blocked !== true
  return { text: `${str(r.row.shop_name) || "(unnamed shop)"} (subdomain ${str(r.row.subdomain) || "none"}, id ${id})${active ? "" : " is not active: the request is refused"}`, ok: active }
}

async function domainCreateCard(i: EntryInput, ctx: CardCtx): Promise<Card> {
  const b = asBody(i)
  const domain = normaliseDomain(str(b.domain))
  const wildcard = b.wildcard_shops_enabled === true
  const lines: CardLine[] = [
    { label: "Domain", value: domain },
    { label: "Site name", value: str(b.site_name).trim() },
    { label: "Services shown", value: list(b.services) },
    { label: "Logo link", value: b.logo_url ? str(b.logo_url) : "(none)" },
    { label: "Color", value: b.primary_color ? str(b.primary_color) : "(default)" },
    { label: "Hidden pages", value: list(b.hidden_pages) },
    { label: "Every shop as a subdomain", value: onOff(wildcard) },
  ]
  if (isReservedDomainHost(domain, ROOT_DOMAIN)) lines.push({ label: "Problem", value: `${domain} collides with the main site's own addresses: the request is refused.` })
  const dup = await readOne(() => ctx.db.from("custom_domains").select("id, domain").eq("domain", domain).maybeSingle())
  if (dup.state === "found") lines.push({ label: "Problem", value: `${domain} is already configured: the request is refused.` })
  if (b.linked_shop_id) {
    const s = await shopLine(ctx, str(b.linked_shop_id))
    lines.push({ label: "Linked shop", value: wildcard ? `${s.text}; ignored because every-shop mode wins and clears the link` : s.text })
  } else {
    lines.push({ label: "Linked shop", value: "(none: the domain shows the normal site)" })
  }
  lines.push(
    { label: "What changes", value: "Visitors to this domain are served this site with the name, logo and services above, starting within about 5 minutes. It only works if the domain's DNS already points at Datagod." },
    { label: "Status", value: "The domain is created active." },
  )
  return { summary: `Add the custom domain ${domain}`, lines }
}

async function domainPatchCard(i: EntryInput, ctx: CardCtx): Promise<Card> {
  const b = asBody(i)
  const id = str(b.id)
  const cur = await readOne(() => ctx.db.from("custom_domains").select("*").eq("id", id).maybeSingle())
  const lines: CardLine[] = []
  if (cur.state === "missing") return { summary: "Change a custom domain", lines: [{ label: "Problem", value: `No custom domain with id ${id}: the request is refused.` }] }
  const old = cur.state === "found" ? cur.row : null
  lines.push({ label: "Domain", value: old ? str(old.domain) : `id ${id} (could not be read)` })
  if (cur.state === "unread") lines.push(UNREAD)
  const rows: Array<[string, string, (v: unknown) => string]> = [
    ["site_name", "Site name", (v) => shown(v)],
    ["services", "Services shown", (v) => list(v)],
    ["logo_url", "Logo link", (v) => (v ? String(v) : "(none)")],
    ["primary_color", "Color", (v) => (v ? String(v) : "(default)")],
    ["is_active", "Status", (v) => (v === true ? "active" : "not active")],
    ["hidden_pages", "Hidden pages", (v) => list(v)],
    ["wildcard_shops_enabled", "Every shop as a subdomain", (v) => onOff(v === true)],
  ]
  let n = 0
  for (const [k, label, f] of rows) {
    if (b[k] === undefined) continue
    n++
    const next = k === "site_name" ? str(b[k]).trim() : b[k]
    lines.push({ label, value: change(old ? f(old[k]) : "(unknown)", f(next)) })
  }
  if (b.linked_shop_id !== undefined) {
    n++
    const oldShop = old?.linked_shop_id ? `shop ${str(old.linked_shop_id)}` : "(none)"
    if (b.linked_shop_id) {
      const s = await shopLine(ctx, str(b.linked_shop_id))
      lines.push({ label: "Linked shop", value: change(oldShop, s.text) })
    } else {
      lines.push({ label: "Linked shop", value: change(oldShop, "(none)") })
    }
  }
  if (n === 0) lines.push({ label: "Problem", value: "Nothing to change: no field was sent, so the request is refused." })
  if (b.wildcard_shops_enabled === true) lines.push({ label: "Note", value: "Turning on every-shop mode clears any single linked shop." })
  else if (b.linked_shop_id) lines.push({ label: "Note", value: "Linking a shop turns every-shop mode off." })
  if (b.is_active === false) lines.push({ label: "What changes", value: "The domain stops serving the site: visitors are no longer routed to it." })
  else lines.push({ label: "What changes", value: "What visitors of this domain see changes within about 5 minutes." })
  return { summary: "Change a custom domain", lines }
}

async function domainDeleteCard(i: EntryInput, ctx: CardCtx): Promise<Card> {
  const id = str(asQuery(i).id)
  const cur = await readOne(() => ctx.db.from("custom_domains").select("id, domain, site_name, is_active, linked_shop_id").eq("id", id).maybeSingle())
  const lines: CardLine[] = []
  if (cur.state === "found") {
    lines.push(
      { label: "Domain", value: str(cur.row.domain) },
      { label: "Site name", value: str(cur.row.site_name) },
      { label: "Status now", value: cur.row.is_active === true ? "active" : "not active" },
    )
  } else if (cur.state === "missing") {
    lines.push({ label: "Problem", value: `No custom domain with id ${id}: nothing is deleted.` })
  } else {
    lines.push({ label: "Domain", value: `id ${id} (could not be read)` }, UNREAD)
  }
  lines.push({ label: "What changes", value: "The domain is deleted for good. It stops working at once for visitors and its saved name, logo and settings are lost. This cannot be undone." })
  return { summary: "Delete a custom domain", lines }
}

// ---------------------------------------------------------------------------------------------------------------------
// support settings
// ---------------------------------------------------------------------------------------------------------------------

async function supportCard(i: EntryInput, ctx: CardCtx): Promise<Card> {
  const b = asBody(i)
  const cur = await readOne(() => ctx.db.from("support_settings").select("*").limit(1).maybeSingle())
  const old = cur.state === "found" ? cur.row : null
  const o = (k: string) => (cur.state === "unread" ? "(unknown)" : shown(old?.[k]))
  const lines: CardLine[] = [{ label: "WhatsApp number", value: change(o("support_whatsapp"), str(b.support_whatsapp)) }]
  lines.push({ label: "Support email", value: b.support_email === undefined ? `${o("support_email")} (unchanged)` : change(o("support_email"), str(b.support_email)) })
  lines.push({ label: "Support phone", value: b.support_phone === undefined ? `${o("support_phone")} (unchanged)` : change(o("support_phone"), str(b.support_phone)) })
  lines.push({ label: "Guest purchase link", value: change(o("guest_purchase_url"), b.guest_purchase_url ? str(b.guest_purchase_url) : `(cleared: ${b.guest_purchase_url === undefined ? "it was not sent" : "sent empty"})`) })
  lines.push({ label: "Guest purchase button text", value: change(o("guest_purchase_button_text"), b.guest_purchase_button_text ? str(b.guest_purchase_button_text) : "Buy as Guest") })
  if (cur.state === "unread") lines.push(UNREAD)
  if (cur.state === "missing") lines.push({ label: "Note", value: "No support settings are saved yet: a new row is created." })
  lines.push({ label: "Who is affected", value: "Every customer: these are the contact details and guest link shown on the site and used in messages. Customers will contact whoever owns the new number, so check it is ours." })
  return { summary: "Change the support contact details", lines }
}

// ---------------------------------------------------------------------------------------------------------------------
// ai-config
// ---------------------------------------------------------------------------------------------------------------------

const AI_PROVIDERS = [
  ["anthropic", "Anthropic"],
  ["openai", "OpenAI"],
  ["gemini", "Gemini"],
  ["deepseek", "DeepSeek"],
  ["groq", "Groq"],
] as const
const providerEnum = z.enum(["anthropic", "openai", "gemini", "deepseek", "groq"])
const model = z.string().min(1).max(100)
const CONTEXTS = ["storefront", "dashboard", "admin", "whatsapp"] as const

const aiConfigBody = z
  .object({
    ...assistantSettingsInputSchema.shape,
    storefront_provider: providerEnum.optional(),
    storefront_model: model.optional(),
    dashboard_provider: providerEnum.optional(),
    dashboard_model: model.optional(),
    admin_provider: providerEnum.optional(),
    admin_model: model.optional(),
    whatsapp_provider: providerEnum.optional(),
    whatsapp_model: model.optional(),
  })
  .strict()

async function aiConfigCard(i: EntryInput, ctx: CardCtx): Promise<Card> {
  const b = asBody(i)
  const r = await adminSetting(ctx, "ai_provider_config")
  const cfg = valueOf(r) ?? {}
  const known = r.state !== "unread"
  const s = resolveAssistantSettings(cfg)
  const was = (v: string) => (known ? v : "(unknown)")
  const lines: CardLine[] = []
  if (!known) lines.push({ label: "Problem", value: "The current assistant settings could not be read just now, so old values cannot be shown." })
  if (b.assistant_name !== undefined) lines.push({ label: "Assistant name", value: change(was(s.name), str(b.assistant_name).trim()) })
  if (b.tone !== undefined) lines.push({ label: "Tone", value: change(was(s.tone), str(b.tone)) })
  if (b.max_tool_steps !== undefined) lines.push({ label: "Most tool steps per answer", value: change(was(s.maxToolSteps === null ? "default (admins 20, others 10)" : String(s.maxToolSteps)), b.max_tool_steps === null ? "default (admins 20, others 10)" : String(b.max_tool_steps)) })
  if (b.audiences && typeof b.audiences === "object") {
    const a = b.audiences as Record<string, boolean>
    const names: Record<string, string> = { admins: "admins", signedIn: "signed-in users", shopVisitors: "shop visitors", publicVisitors: "public visitors" }
    for (const k of Object.keys(names)) {
      lines.push({ label: `Assistant for ${names[k]}`, value: change(was(onOff((s.audiences as unknown as Record<string, boolean>)[k])), onOff(a[k] === true)) })
      if (a[k] === false) lines.push({ label: `Assistant for ${names[k]}: effect`, value: `The assistant is switched off for ${names[k]}.` })
    }
  }
  if (b.admin_catalog_enabled !== undefined) {
    const next = b.admin_catalog_enabled === true
    lines.push({ label: "Admin catalog access", value: change(was(onOff(s.adminCatalog)), onOff(next)) })
    lines.push({
      label: "Admin catalog access: effect",
      value: next
        ? "The assistant can look things up and prepare changes on the admin pages (every change still needs your Confirm)."
        : "The assistant loses its admin page access: it can no longer look up or prepare changes on the admin pages, including this one. Turning it back on needs the AI Assistant settings page.",
    })
  }
  for (const c of CONTEXTS) {
    const pk = `${c}_provider`
    const mk2 = `${c}_model`
    if (b[pk] !== undefined) lines.push({ label: `${c} assistant provider`, value: change(was(str(cfg[pk]) || (DEFAULT_CONFIG as Record<string, string>)[pk]), str(b[pk])) })
    if (b[mk2] !== undefined) lines.push({ label: `${c} assistant model`, value: change(was(str(cfg[mk2]) || (DEFAULT_CONFIG as Record<string, string>)[mk2]), str(b[mk2])) })
  }
  lines.push(
    { label: "API keys", value: "replaced only for the boxes you fill in; empty boxes keep the saved key." },
    { label: "Keys", value: "Type each new key in the secure box on this card, never in chat. Keys are never shown here." },
    { label: "Who is affected", value: "Every chat assistant on the site: which model answers, who may use it and what it can do change within about a minute. Nothing is sent to customers." },
  )
  return { summary: "Change the AI assistant settings", lines }
}

// ---------------------------------------------------------------------------------------------------------------------
// ai-knowledge
// ---------------------------------------------------------------------------------------------------------------------

const knowledgeContexts = z.array(z.enum(["storefront", "dashboard", "admin"])).min(1).max(3)
const knowledgeQuestion = z.string().min(1).max(500)
const knowledgeAnswer = z.string().min(1).max(4000)
const knowledgeCategory = z.string().min(1).max(50)

async function knowledgeCreateCard(i: EntryInput): Promise<Card> {
  const b = asBody(i)
  const contexts = (b.contexts as string[] | undefined) ?? ["storefront", "dashboard", "admin"]
  return {
    summary: "Add a knowledge entry for the assistants",
    lines: [
      { label: "Category", value: str(b.category).trim() || "faq" },
      { label: "Question", value: str(b.question).trim() },
      { label: "Answer", value: str(b.answer).trim() },
      { label: "Used by", value: list(contexts) },
      { label: "What changes", value: "The chat assistants use this entry when answering customers (storefront, dashboard) or admins, within about a minute. Whatever the answer says, customers will be told as fact: check it for wrong payment details or links." },
    ],
  }
}

async function knowledgePatchCard(i: EntryInput, ctx: CardCtx): Promise<Card> {
  const b = asBody(i)
  const id = str(b.id)
  const cur = await readOne(() => ctx.db.from("ai_knowledge").select("*").eq("id", id).maybeSingle())
  if (cur.state === "missing") return { summary: "Change a knowledge entry", lines: [{ label: "Problem", value: `No knowledge entry with id ${id}: the request is refused.` }] }
  const old = cur.state === "found" ? cur.row : null
  const o = (k: string, f: (v: unknown) => string) => (old ? f(old[k]) : "(unknown)")
  const lines: CardLine[] = [{ label: "Entry", value: old ? str(old.question) : `id ${id} (could not be read)` }]
  if (cur.state === "unread") lines.push(UNREAD)
  let n = 0
  if (b.category !== undefined) { n++; lines.push({ label: "Category", value: change(o("category", shown), str(b.category)) }) }
  if (b.question !== undefined) { n++; lines.push({ label: "Question", value: change(o("question", shown), str(b.question)) }) }
  if (b.answer !== undefined) { n++; lines.push({ label: "Answer", value: change(o("answer", shown), str(b.answer)) }) }
  if (b.contexts !== undefined) { n++; lines.push({ label: "Used by", value: change(o("contexts", list), list(b.contexts)) }) }
  if (b.is_active !== undefined) { n++; lines.push({ label: "Active", value: change(o("is_active", (v) => (v === false ? "no" : "yes")), b.is_active === true ? "yes" : "no") }) }
  if (n === 0) lines.push({ label: "Problem", value: "Nothing to change: no field was sent." })
  lines.push({ label: "What changes", value: "The chat assistants use the new text when answering, within about a minute. Whatever it says, customers will be told as fact." })
  return { summary: "Change a knowledge entry", lines }
}

async function knowledgeDeleteCard(i: EntryInput, ctx: CardCtx): Promise<Card> {
  const id = str(asQuery(i).id)
  const cur = await readOne(() => ctx.db.from("ai_knowledge").select("id, category, question").eq("id", id).maybeSingle())
  const lines: CardLine[] = []
  if (cur.state === "found") lines.push({ label: "Entry", value: str(cur.row.question) }, { label: "Category", value: str(cur.row.category) })
  else if (cur.state === "missing") lines.push({ label: "Note", value: `No knowledge entry with id ${id}: nothing is deleted.` })
  else lines.push({ label: "Entry", value: `id ${id} (could not be read)` }, UNREAD)
  lines.push({ label: "What changes", value: "The entry is deleted for good and the assistants stop using it. This cannot be undone." })
  return { summary: "Delete a knowledge entry", lines }
}

// ---------------------------------------------------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------------------------------------------------

const direct = {
  storefront: directChargeCard(
    "Storefront direct MoMo charge",
    ["storefront"],
    "Shop orders are paid with an on-page MoMo prompt (the customer approves on their phone) instead of the hosted checkout page.",
    "Shop orders are paid on the hosted checkout page again.",
  ),
  wallet: directChargeCard(
    "Wallet and upgrade direct MoMo charge",
    ["wallet_topup", "dashboard_direct", "sms"],
    "Wallet top-ups, dealer upgrades, dashboard buying and SMS payment links use an on-page MoMo prompt instead of the hosted checkout page.",
    "Wallet top-ups, dealer upgrades, dashboard buying and SMS payment links use the hosted checkout page again.",
  ),
}

export const SETTINGS_ENTRIES: CatalogEntry[] = [
  // ---- site settings ----
  mk({
    id: "settings.read_site_settings",
    ...where("/admin/settings"),
    summary: "Read the site-wide settings: ordering, signups, fees, price adjustments, announcements and links. (The very first read creates the default row if none exists.)",
    method: "GET",
    path: "/api/admin/settings",
    kind: "lookup", // ruling G-default: only inserts the default row when missing
    risk: "normal",
    auth: "admin",
    resultKeep: [
      "ordering_enabled",
      "signups_enabled",
      "signup_default_role",
      "wallet_topups_enabled",
      "upgrades_enabled",
      "announcement_enabled",
      "announcement_title",
      "announcement_message",
      "storefront_announcement_enabled",
      "paystack_fee_percentage",
      "wallet_topup_fee_percentage",
      "withdrawal_fee_percentage",
      "withdrawal_fee_minimum",
      "minimum_withdrawal_amount",
      "price_adjustment_mtn",
      "price_adjustment_telecel",
      "price_adjustment_at_ishare",
      "price_adjustment_at_bigtime",
      "supplier_cost_per_gb_mtn",
      "supplier_cost_per_gb_telecel",
      "supplier_cost_per_gb_at_ishare",
      "supplier_cost_per_gb_at_bigtime",
      "ussd_price_tier",
      "ussd_shop_dial_code",
      "ussd_shop_activation_fee",
      "whatsapp_shop_activation_fee",
      "sub_agent_open_join_enabled",
    ],
  }),
  mk({
    id: "settings.update_site_settings",
    ...where("/admin/settings"),
    summary: "Change site-wide settings: ordering on/off, signups, wallet top-ups, fees, price adjustments, supplier costs, announcements and links. Only the fields sent are changed.",
    method: "PUT",
    path: "/api/admin/settings",
    body: siteBody,
    kind: "change",
    risk: "danger",
    auth: "admin",
    card: siteSettingsCard,
  }),

  // ---- afa ----
  ...toggleEntries(toggleByPath("/api/admin/settings/afa-auto-fulfillment")),
  mk({
    id: "afa_provider.read",
    ...where("/admin/afa-management"),
    summary: "Show which provider handles new AFA registrations.",
    method: "GET",
    path: "/api/admin/settings/afa-provider",
    kind: "lookup",
    risk: "normal",
    auth: "admin",
    resultKeep: ["provider", "availableProviders"],
  }),
  mk({
    id: "afa_provider.set",
    ...where("/admin/afa-management"),
    summary: "Choose which provider (Sykes or Apex Prime) handles new AFA registrations.",
    method: "POST",
    path: "/api/admin/settings/afa-provider",
    body: z.object({ provider: z.enum(["sykes", "apexprime"]) }).strict(),
    kind: "change",
    risk: "danger",
    auth: "admin",
    card: afaProviderCard,
  }),

  // ---- fulfilment switches ----
  ...toggleEntries(toggleByPath("/api/admin/settings/auto-fulfillment")),
  ...toggleEntries(toggleByPath("/api/admin/settings/mtn-auto-fulfillment")),
  ...toggleEntries(toggleByPath("/api/admin/settings/mtn-registration-gate")),
  ...toggleEntries(toggleByPath("/api/admin/settings/strict-supplier-verify")),
  mk({
    id: "mtn_provider.read",
    ...where("/admin/settings/mtn"),
    summary: "Show the main MTN supplier.",
    method: "GET",
    path: "/api/admin/settings/mtn-provider",
    kind: "lookup",
    risk: "normal",
    auth: "admin",
    resultKeep: ["provider"],
  }),
  mk({
    id: "mtn_provider.set",
    ...where("/admin/settings/mtn"),
    summary: "Choose the main supplier all new MTN orders are sent to.",
    method: "POST",
    path: "/api/admin/settings/mtn-provider",
    body: z.object({ provider: mtnProvider }).strict(),
    kind: "change",
    risk: "danger",
    auth: "admin",
    card: mtnProviderCard,
  }),
  mk({
    id: "mtn_disabled_providers.read",
    ...where("/admin/settings/mtn"),
    summary: "Show which MTN suppliers are deactivated.",
    method: "GET",
    path: "/api/admin/settings/mtn-disabled-providers",
    kind: "lookup",
    risk: "normal",
    auth: "admin",
    resultKeep: ["disabled"],
  }),
  mk({
    id: "mtn_disabled_providers.set",
    ...where("/admin/settings/mtn"),
    summary: "Set which MTN suppliers are deactivated (at least one must stay active).",
    method: "POST",
    path: "/api/admin/settings/mtn-disabled-providers",
    body: z.object({ disabled: z.array(mtnProvider).max(MTN_PROVIDERS.length - 1) }).strict(),
    kind: "change",
    risk: "danger",
    auth: "admin",
    card: mtnDisabledCard,
  }),
  mk({
    id: "mtn_retry_sequence.read",
    ...where("/admin/settings/mtn"),
    summary: "Show the MTN retry order: whether failed sends move to the next supplier, and the order.",
    method: "GET",
    path: "/api/admin/settings/mtn-retry-sequence",
    kind: "lookup",
    risk: "normal",
    auth: "admin",
    resultKeep: ["enabled", "providers"],
  }),
  mk({
    id: "mtn_retry_sequence.set",
    ...where("/admin/settings/mtn"),
    summary: "Turn the MTN retry order on or off and set the order of suppliers to try.",
    method: "POST",
    path: "/api/admin/settings/mtn-retry-sequence",
    body: z.object({ enabled: bool, providers: z.array(mtnProvider).max(MTN_PROVIDERS.length) }).strict(),
    kind: "change",
    risk: "danger",
    auth: "admin",
    card: mtnRetryCard,
  }),
  mk({
    id: "network_provider.read",
    ...where("/admin/settings/mtn"),
    summary: "Show which supplier handles Telecel, AT iShare or AT BigTime orders.",
    method: "GET",
    path: "/api/admin/settings/network-provider",
    query: z.object({ network: z.enum(["telecel", "at_ishare", "at_bigtime"]) }).strict(),
    kind: "lookup",
    risk: "normal",
    auth: "admin",
    resultKeep: ["provider"],
  }),
  mk({
    id: "network_provider.set",
    ...where("/admin/settings/mtn"),
    summary: "Choose the supplier all new Telecel, AT iShare or AT BigTime orders are sent to.",
    method: "POST",
    path: "/api/admin/settings/network-provider",
    body: z.object({ network: z.enum(["telecel", "at_ishare", "at_bigtime"]), provider: z.enum(allNetworkProviders) }).strict(),
    kind: "change",
    risk: "danger",
    auth: "admin",
    card: networkProviderCard,
  }),
  mk({
    id: "balance_threshold.read",
    ...where("/admin/settings/mtn"),
    summary: "Show the MTN supplier balance level at which the low-balance alert fires.",
    method: "GET",
    path: "/api/admin/settings/balance-threshold",
    kind: "lookup",
    risk: "normal",
    auth: "admin",
    resultKeep: ["threshold"],
  }),
  mk({
    id: "balance_threshold.set",
    ...where("/admin/settings/mtn"),
    summary: "Set the MTN supplier balance level (GHS) at which the low-balance alert fires.",
    method: "POST",
    path: "/api/admin/settings/balance-threshold",
    body: z.object({ threshold: z.number().int().min(0).max(1000000) }).strict(),
    kind: "change",
    risk: "normal",
    auth: "admin",
    card: balanceThresholdCard,
  }),
  mk({
    id: "blocked_numbers_settings.read",
    ...where("/admin/settings/mtn"),
    summary: "Show the blocked-number tracking settings.",
    method: "GET",
    path: "/api/admin/settings/blocked-numbers",
    kind: "lookup",
    risk: "normal",
    auth: "admin",
    resultKeep: ["settings.enabled", "settings.customer_sms_enabled", "settings.retention_days", "settings.spike_threshold_per_hour", "settings.daily_sms_ceiling"],
  }),
  mk({
    id: "blocked_numbers_settings.set",
    ...where("/admin/settings/mtn"),
    summary: "Change the blocked-number tracking switch, customer SMS switch, retention, alert level and daily SMS limit. Only the fields sent are changed.",
    method: "POST",
    path: "/api/admin/settings/blocked-numbers",
    body: z
      .object({
        enabled: bool.optional(),
        customer_sms_enabled: bool.optional(),
        retention_days: z.number().int().min(1).max(365).optional(),
        spike_threshold_per_hour: z.number().int().min(1).max(10000).optional(),
        daily_sms_ceiling: z.number().int().min(0).max(10000).optional(),
      })
      .strict(),
    kind: "change",
    risk: "danger",
    auth: "admin",
    card: blockedCard,
  }),
  mk({
    id: "customer_verification.read",
    ...where("/admin/settings/mtn"),
    summary: "Show the live phone-number check shown to customers at checkout.",
    method: "GET",
    path: "/api/admin/settings/customer-verification",
    kind: "lookup",
    risk: "normal",
    auth: "admin",
    resultKeep: ["settings.enabled", "settings.providers", "settings.block_unverified", "availableProviders"],
  }),
  mk({
    id: "customer_verification.set",
    ...where("/admin/settings/mtn"),
    summary: "Turn the live phone-number check at checkout on or off, pick the suppliers asked, and choose whether rejected numbers are blocked.",
    method: "POST",
    path: "/api/admin/settings/customer-verification",
    body: z.object({ enabled: bool, providers: z.array(z.enum(CHECKING_PROVIDERS)).max(CHECKING_PROVIDERS.length), block_unverified: bool.optional() }).strict(),
    kind: "change",
    risk: "danger",
    auth: "admin",
    card: customerVerificationCard,
  }),
  ...toggleEntries(toggleByPath("/api/admin/settings/network-prefix-validation")),
  mk({
    id: "network_prefixes.read",
    ...where("/admin/settings"),
    summary: "Show which phone-number prefixes belong to MTN, Telecel and AT.",
    method: "GET",
    path: "/api/admin/settings/network-prefixes",
    kind: "lookup",
    risk: "normal",
    auth: "admin",
    resultKeep: ["map"],
  }),
  mk({
    id: "network_prefixes.change",
    ...where("/admin/settings"),
    summary: "Add or remove a phone-number prefix for MTN, Telecel or AT.",
    method: "POST",
    path: "/api/admin/settings/network-prefixes",
    body: z.object({ network: z.enum(["MTN", "TELECEL", "AT"]), prefix: z.string().regex(/^0?[2-9]\d$/), action: z.enum(["add", "remove"]) }).strict(),
    kind: "change",
    risk: "danger",
    auth: "admin",
    card: prefixCard,
  }),

  // ---- page content and links ----
  mk({
    id: "google_review_url.read",
    ...where("/admin/settings"),
    summary: "Show the Google review link customers are asked to open.",
    method: "GET",
    path: "/api/admin/settings/google-review-url",
    kind: "lookup",
    risk: "normal",
    auth: "admin",
    resultKeep: ["url"],
  }),
  mk({
    id: "google_review_url.set",
    ...where("/admin/settings"),
    summary: "Set or clear the Google review link (https Google links only).",
    method: "POST",
    path: "/api/admin/settings/google-review-url",
    body: z.object({ url: z.string().max(500).refine((v) => validateReviewUrl(v).ok, "must be an https Google review link, or empty to clear").nullable() }).strict(),
    kind: "change",
    risk: "normal",
    auth: "admin",
    card: reviewUrlCard,
  }),
  mk({
    id: "public_ussd_codes.read",
    ...where("/admin/settings"),
    summary: "Show the USSD codes advertised on the public site.",
    method: "GET",
    path: "/api/admin/settings/public-ussd-codes",
    kind: "lookup",
    risk: "normal",
    auth: "admin",
    resultKeep: ["codes.main", "codes.shop"],
  }),
  mk({
    id: "public_ussd_codes.set",
    ...where("/admin/settings"),
    summary: "Set or clear the main USSD code advertised on the public site.",
    method: "POST",
    path: "/api/admin/settings/public-ussd-codes",
    body: z.object({ main: z.string().max(30).refine((v) => v === "" || USSD_CODE_RE.test(v), "must look like *920#").nullable() }).strict(),
    kind: "change",
    risk: "danger",
    auth: "admin",
    card: ussdCodeCard,
  }),

  // ---- payment gates ----
  mk({
    id: "storefront_direct_charge.read",
    ...where("/admin/gateway"),
    summary: "Show whether shop orders are paid with an on-page MoMo prompt.",
    method: "GET",
    path: "/api/admin/settings/storefront-direct-charge",
    kind: "lookup",
    risk: "normal",
    auth: "admin",
    resultKeep: ["enabled"],
  }),
  mk({
    id: "storefront_direct_charge.set",
    ...where("/admin/gateway"),
    summary: "Turn the on-page MoMo prompt for shop order payments on or off.",
    method: "POST",
    path: "/api/admin/settings/storefront-direct-charge",
    body: z.object({ enabled: bool }).strict(),
    kind: "change",
    risk: "danger",
    auth: "admin",
    card: direct.storefront,
  }),
  mk({
    id: "wallet_direct_charge.read",
    ...where("/admin/gateway"),
    summary: "Show whether wallet top-ups and upgrades are paid with an on-page MoMo prompt.",
    method: "GET",
    path: "/api/admin/settings/wallet-direct-charge",
    kind: "lookup",
    risk: "normal",
    auth: "admin",
    resultKeep: ["enabled"],
  }),
  mk({
    id: "wallet_direct_charge.set",
    ...where("/admin/gateway"),
    summary: "Turn the on-page MoMo prompt for wallet top-ups, upgrades, dashboard buying and SMS payment links on or off.",
    method: "POST",
    path: "/api/admin/settings/wallet-direct-charge",
    body: z.object({ enabled: bool }).strict(),
    kind: "change",
    risk: "danger",
    auth: "admin",
    card: direct.wallet,
  }),
  ...toggleEntries(toggleByPath("/api/admin/settings/storefront-otp")),
  ...toggleEntries(toggleByPath("/api/admin/settings/wallet-otp")),
  ...toggleEntries(toggleByPath("/api/admin/settings/turnstile")),
  ...toggleEntries(toggleByPath("/api/admin/settings/ussd-shop-memory")),
  ...toggleEntries(toggleByPath("/api/admin/settings/ussd-whitelist")),
  mk({
    id: "ussd_whitelist_numbers.list",
    ...where("/admin/settings"),
    summary: "List the phone numbers on the USSD whitelist.",
    method: "GET",
    path: "/api/admin/settings/ussd-whitelist/numbers",
    kind: "lookup",
    risk: "normal",
    auth: "admin",
    resultKeep: ["count", "numbers[].phone_number"],
  }),
  mk({
    id: "ussd_whitelist_numbers.add",
    ...where("/admin/settings"),
    summary: "Add phone numbers to the USSD whitelist (up to 500 at once).",
    method: "POST",
    path: "/api/admin/settings/ussd-whitelist/numbers",
    body: z.object({ numbers: z.array(z.string().min(1).max(20)).min(1).max(500) }).strict(),
    kind: "change",
    risk: "normal",
    auth: "admin",
    card: whitelistAddCard,
  }),
  mk({
    id: "ussd_whitelist_numbers.remove",
    ...where("/admin/settings"),
    summary: "Remove one phone number from the USSD whitelist.",
    method: "DELETE",
    path: "/api/admin/settings/ussd-whitelist/numbers",
    body: z.object({ phone_number: z.string().min(1).max(20) }).strict(),
    kind: "change",
    risk: "normal",
    auth: "admin",
    card: whitelistRemoveCard,
  }),

  // ---- payment gateway ----
  mk({
    id: "gateway.get_config",
    ...where("/admin/gateway"),
    summary: "Show which payment provider, mode and fee payer each payment surface uses, and whether Hubtel is set up.",
    method: "GET",
    path: "/api/admin/gateway",
    kind: "lookup",
    risk: "normal",
    auth: "admin",
    resultKeep: ["config.surfaces", "config.hubtelFeePercent", "hubtel.ready", "hubtel.missing"],
  }),
  mk({
    id: "gateway.set_config",
    ...where("/admin/gateway"),
    summary: "Change the payment provider (Paystack or Hubtel), checkout mode and fee payer for each payment surface, and the Hubtel fee percent. Send every surface.",
    method: "PUT",
    path: "/api/admin/gateway",
    body: gatewayBody,
    kind: "change",
    risk: "danger",
    auth: "admin",
    card: gatewayCard,
  }),
  mk({
    id: "gateway.hubtel_review_list",
    ...where("/admin/gateway"),
    summary: "List Hubtel payments waiting for a human decision (needs review, or stuck confirming).",
    method: "GET",
    path: "/api/admin/gateway/hubtel-payments",
    kind: "lookup",
    risk: "normal",
    auth: "admin",
    resultKeep: ["items[].reference", "items[].internalReference", "items[].surface", "items[].amountGhs", "items[].status", "items[].reason", "items[].ageMinutes", "items[].createdAt"],
  }),
  mk({
    id: "gateway.hubtel_review_action",
    ...where("/admin/gateway"),
    summary: "Act on a Hubtel payment waiting for review: re-check it, fulfil it, mark it failed, or record that you refunded a second payment by hand.",
    method: "POST",
    path: "/api/admin/gateway/hubtel-payments",
    body: hubtelBody,
    kind: "change",
    risk: "money",
    auth: "admin",
    timeoutMs: 60000,
    card: hubtelCard,
  }),

  // ---- delivery channels, theme ----
  mk({
    id: "delivery_channels.list",
    ...where("/admin/packages"),
    summary: "Show every delivery channel and whether it is marked down.",
    method: "GET",
    path: "/api/admin/delivery-channels",
    kind: "lookup",
    risk: "normal",
    auth: "admin",
    resultKeep: ["channels[].channel", "channels[].label", "channels[].isManuallyDown", "channels[].reason", "channels[].since"],
  }),
  mk({
    id: "delivery_channels.set",
    ...where("/admin/packages"),
    summary: "Mark a delivery channel down (with a reason) or back to normal on the delivery-time display.",
    method: "POST",
    path: "/api/admin/delivery-channels",
    body: z
      .object({
        channel: z.enum(["mtn", "telecel", "at_ishare", "at_bigtime", "utility", "standard"]),
        down: bool,
        reason: z.string().max(200).optional(),
      })
      .strict(),
    kind: "change",
    risk: "danger",
    auth: "admin",
    card: deliveryCard,
  }),
  mk({
    id: "christmas_theme.read",
    ...where("/admin/settings"),
    summary: "Show whether the Christmas theme is on.",
    method: "GET",
    path: "/api/admin/christmas-theme",
    kind: "lookup",
    risk: "normal",
    auth: "other", // this GET does not check who is asking (it is a public theme flag)
    resultKeep: ["christmas_theme_enabled"],
  }),
  mk({
    id: "christmas_theme.set",
    ...where("/admin/settings"),
    summary: "Turn the Christmas theme on or off for the whole site.",
    method: "PUT",
    path: "/api/admin/christmas-theme",
    body: z.object({ christmas_theme_enabled: bool }).strict(),
    kind: "change",
    risk: "normal",
    auth: "admin",
    card: christmasCard,
  }),

  // ---- custom domains ----
  mk({
    id: "custom_domains.list",
    ...where("/admin/custom-domains"),
    summary: "List the custom domains with their site name, services, status and linked shop.",
    method: "GET",
    path: "/api/admin/custom-domains",
    kind: "lookup",
    risk: "normal",
    auth: "admin",
    resultKeep: [
      "domains[].id",
      "domains[].domain",
      "domains[].site_name",
      "domains[].services",
      "domains[].is_active",
      "domains[].linked_shop_id",
      "domains[].wildcard_shops_enabled",
      "domains[].hidden_pages",
      "domains[].primary_color",
    ],
  }),
  mk({
    id: "custom_domains.create",
    ...where("/admin/custom-domains"),
    summary: "Add a custom domain that serves the site (or one shop) with its own name, logo, color and services.",
    method: "POST",
    path: "/api/admin/custom-domains",
    body: z
      .object({
        domain: domainName,
        site_name: z.string().trim().min(1).max(100),
        services: z.array(z.enum(DOMAIN_SERVICES)).min(1).max(4),
        logo_url: httpsUrl.optional(),
        primary_color: colorText.optional(),
        hidden_pages: z.array(z.enum(PAGE_KEYS)).max(PAGE_KEYS.length).optional(),
        wildcard_shops_enabled: bool.optional(),
        linked_shop_id: uuid.nullable().optional(),
      })
      .strict(),
    kind: "change",
    risk: "danger",
    auth: "admin",
    card: domainCreateCard,
  }),
  mk({
    id: "custom_domains.update",
    ...where("/admin/custom-domains"),
    summary: "Change a custom domain: its name, logo, color, services, hidden pages, linked shop, every-shop mode or active status. Only the fields sent are changed.",
    method: "PATCH",
    path: "/api/admin/custom-domains",
    body: z
      .object({
        id: uuid,
        site_name: z.string().trim().min(1).max(100).optional(),
        services: z.array(z.enum(DOMAIN_SERVICES)).min(1).max(4).optional(),
        logo_url: httpsUrl.nullable().optional(),
        primary_color: colorText.nullable().optional(),
        is_active: bool.optional(),
        hidden_pages: z.array(z.enum(PAGE_KEYS)).max(PAGE_KEYS.length).optional(),
        wildcard_shops_enabled: bool.optional(),
        linked_shop_id: uuid.nullable().optional(),
      })
      .strict(),
    kind: "change",
    risk: "danger",
    auth: "admin",
    card: domainPatchCard,
  }),
  mk({
    id: "custom_domains.delete",
    ...where("/admin/custom-domains"),
    summary: "Delete a custom domain for good.",
    method: "DELETE",
    path: "/api/admin/custom-domains",
    query: z.object({ id: uuid }).strict(),
    kind: "change",
    risk: "danger",
    auth: "admin",
    card: domainDeleteCard,
  }),

  // ---- support ----
  mk({
    id: "support_settings.set",
    ...where("/admin/settings"),
    summary: "Change the support WhatsApp number, email and phone and the guest-purchase link and button text shown to customers.",
    method: "POST",
    path: "/api/admin/support-settings",
    body: z
      .object({
        support_whatsapp: z.string().regex(/^\+?\d{9,15}$/),
        support_email: z.string().email().max(120).optional(),
        support_phone: z.string().regex(/^\+?[\d ]{7,20}$/).optional(),
        guest_purchase_url: z.string().max(300).refine((v) => v === "" || /^\/[^\s]*$/.test(v) || /^https:\/\/\S+$/.test(v), "must be a site path like /guest-buy or an https link").optional(),
        guest_purchase_button_text: z.string().max(40).optional(),
      })
      .strict(),
    kind: "change",
    risk: "danger",
    auth: "admin",
    card: supportCard,
  }),

  // ---- rate limits ----
  mk({
    id: "rate_limits.list",
    ...where("/admin/rate-limits"),
    summary: "List recent rate-limit blocks: which endpoint and who (address or user) was blocked, and when.",
    method: "GET",
    path: "/api/admin/rate-limits",
    query: z
      .object({
        limit: z.number().int().min(1).max(500).optional(),
        offset: z.number().int().min(0).max(100000).optional(),
        endpoint: z.string().max(100).optional(),
        identifier: z.string().max(100).optional(),
      })
      .strict(),
    kind: "lookup",
    risk: "normal",
    auth: "admin",
    resultKeep: ["data[].endpoint", "data[].identifier", "data[].blocked_at", "count", "pagination.limit", "pagination.offset", "pagination.hasMore"],
  }),
  mk({
    id: "rate_limits.reset",
    ...where("/admin/rate-limits"),
    summary: "Clear the rate limit for one endpoint and identifier so the caller can try again at once.",
    method: "POST",
    path: "/api/admin/rate-limits/reset",
    body: z.object({ endpoint: z.string().min(1).max(200), identifier: z.string().min(1).max(200) }).strict(),
    kind: "change",
    risk: "danger",
    auth: "admin",
    card: rateResetCard,
  }),

  // ---- AI assistant ----
  mk({
    id: "ai_config.set",
    ...where("/admin/ai-assistant"),
    summary: "Change the AI assistant's name, tone, who may use it, tool steps, models, admin access, and replace provider API keys (typed in the card's secure box).",
    method: "PUT",
    path: "/api/admin/ai-config",
    body: aiConfigBody,
    secretFields: AI_PROVIDERS.map(([p, label]) => ({ name: `${p}_api_key_new`, label: `${label} API key`, min: 16, max: 300, optional: true })),
    kind: "change",
    risk: "danger",
    auth: "admin",
    card: aiConfigCard,
  }),
  mk({
    id: "ai_knowledge.list",
    ...where("/admin/ai-assistant"),
    summary: "List the assistant's knowledge entries (question, answer, category, who uses it).",
    method: "GET",
    path: "/api/admin/ai-knowledge",
    kind: "lookup",
    risk: "normal",
    auth: "admin",
    resultKeep: ["entries[].id", "entries[].category", "entries[].question", "entries[].answer", "entries[].contexts", "entries[].is_active"],
  }),
  mk({
    id: "ai_knowledge.create",
    ...where("/admin/ai-assistant"),
    summary: "Add a question-and-answer entry the chat assistants will use when answering.",
    method: "POST",
    path: "/api/admin/ai-knowledge",
    body: z.object({ category: knowledgeCategory.optional(), question: knowledgeQuestion, answer: knowledgeAnswer, contexts: knowledgeContexts.optional() }).strict(),
    kind: "change",
    risk: "danger",
    auth: "admin",
    card: knowledgeCreateCard,
  }),
  mk({
    id: "ai_knowledge.update",
    ...where("/admin/ai-assistant"),
    summary: "Change a knowledge entry's category, question, answer, who uses it, or switch it on or off. Only the fields sent are changed.",
    method: "PATCH",
    path: "/api/admin/ai-knowledge",
    body: z
      .object({ id: uuid, category: knowledgeCategory.optional(), question: knowledgeQuestion.optional(), answer: knowledgeAnswer.optional(), contexts: knowledgeContexts.optional(), is_active: yes.optional() })
      .strict(),
    kind: "change",
    risk: "danger",
    auth: "admin",
    card: knowledgePatchCard,
  }),
  mk({
    id: "ai_knowledge.delete",
    ...where("/admin/ai-assistant"),
    summary: "Delete a knowledge entry for good.",
    method: "DELETE",
    path: "/api/admin/ai-knowledge",
    query: z.object({ id: uuid }).strict(),
    kind: "change",
    risk: "danger",
    auth: "admin",
    card: knowledgeDeleteCard,
  }),
]
