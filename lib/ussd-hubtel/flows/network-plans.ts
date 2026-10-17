// lib/ussd-hubtel/flows/network-plans.ts
// "Standard Bundles" (Commission Cashback bots): Hubtel Standard Bundles sold over Hubtel USSD, priced by
// the bot engine (quoteBots, rail hubtel; shop split only for an accepted shop in shop mode) and paid
// through Hubtel's AddToCart. The engine creates the unpaid order (idempotency key = this session);
// submitOrder then writes the hubtel_transactions row and the cart at the order's payAmount.
// Plan and category names are shown exactly as Hubtel sends them (only shortened to fit the screen).
import { recipientPromptText, whoForText } from "../menus"
import { confirmNote } from "../confirm-note"
import crypto from "crypto"
import { validateNetworkPrefix } from "@/lib/phone-format"
import { isValidIdempotencyKey } from "@/lib/standard-bundles/service"
import { CATEGORY_ORDER, type BundleNetwork } from "@/lib/standard-bundles/categories"
import type { BotContext } from "@/lib/bot-commission/context"
import type { BotCatalogResult } from "@/lib/bot-commission/catalog"
import { toLocalPhone, USSD_SCREEN_LIMIT } from "../protocol"
import {
  backToMain, failOrphanEngineOrder, finish, goto, replaySubmittedOrder, say, submitOrder, type FlowCtx, type StepTable,
} from "../flow-kit"
import { clip, fitListScreen, pageSlice } from "../screen-fit"
import { backToProduct } from "./shop"
import type { HubtelReply, HubtelSession, NpPlan } from "../types"

export const NP_PAGE_SIZE = 5
const NETWORKS: readonly BundleNetwork[] = ["MTN", "TELECEL", "AT"]
const NETWORK_LABEL: Record<BundleNetwork, string> = { MTN: "MTN", TELECEL: "Telecel", AT: "AirtelTigo" }
const npLabel = (s: HubtelSession) => (s.npNetwork ? NETWORK_LABEL[s.npNetwork] : "")

const NETWORK = { label: "Select network" }
const CATEGORY = { label: "Select type" }
const PLAN = { label: "Select plan" }
const RECIPIENT = { label: "Recipient" }
const OTHER = { label: "Recipient number", fieldType: "phone" as const }
const CONFIRM = { label: "Confirm order" }

export const NP_TEXT = {
  unavailable: "Service unavailable. Please try again later.",
  priceChanged: "Price changed. Please try again.",
  tooMany: "Too many attempts. Please try later.",
  notAvailable: "Not available right now.",
} as const

const money = (n: number) => n.toFixed(2)

const networkScreen = (prefix = "") =>
  prefix + "Standard Bundles\nSelect network:\n" + NETWORKS.map((n, i) => `${i + 1}. ${NETWORK_LABEL[n]}`).join("\n") + "\n0. Back"

const categoryScreen = (network: BundleNetwork, categories: string[], prefix = "") =>
  fitListScreen(`${prefix}${NETWORK_LABEL[network]} plans:`, categories.map(c => ({ label: c })), ["0. Back"])

function planScreen(network: BundleNetwork, category: string, plans: NpPlan[], hasNext: boolean): string {
  return fitListScreen(
    `${NETWORK_LABEL[network]} ${category}`,
    plans.map(p => ({ label: p.d, suffix: `GHS ${money(p.p)}` })),
    [...(hasNext ? ["0 Next"] : []), "00 Back"],
  )
}

// Same "Who is this for?" step and confirm layout as the data bundle menus.
const recipientScreen = (s: HubtelSession, prefix = "") => `${prefix}${whoForText(toLocalPhone(s.dialingPhone))}`
const otherScreen = (prefix = "") => `${prefix}${recipientPromptText()}`

/**
 * Confirm screen (≤ 182 chars; the plan text is shortened if needed), laid out like the data bundle confirm:
 *   MTN <plan> / To: <number> / Amount: GHS x (was GHS y) / [delivery lines] / / Confirm your order? / 1. Confirm / 0. Cancel
 * "(was …)" only when the price is below face.
 */
export function networkPlanConfirmText(plan: NpPlan, recipient: string, note?: string | null, networkLabel = ""): string {
  const was = plan.p < plan.f ? ` (was GHS ${money(plan.f)})` : ""
  const label = networkLabel ? `${networkLabel} ` : ""
  const desc = plan.d
  const tailWith = (extra: string) => `\nTo: ${recipient}\nAmount: GHS ${money(plan.p)}${was}\n${extra}\nConfirm your order?\n1. Confirm\n0. Cancel`
  const build = (extra: string) => {
    const tail = tailWith(extra)
    return label + clip(desc, USSD_SCREEN_LIMIT - label.length - tail.length) + tail
  }
  // The delivery lines only when the plan text keeps enough room to stay readable.
  const room = note ? USSD_SCREEN_LIMIT - label.length - tailWith(`${note}\n`).length : 0
  return note && room >= Math.min(desc.length, 24) ? build(`${note}\n`) : build("")
}

/** The engine context for this session: shop split only for an accepted shop in shop mode; null = fail closed. */
function botContext(s: HubtelSession): BotContext | null {
  if (s.mode === "shop") {
    if (!s.shopId) return null
    return { botSurface: "hubtel_ussd", shopId: s.shopId, rail: "hubtel", buyerPhone: s.dialingPhone }
  }
  return { botSurface: "hubtel_ussd", shopId: null, rail: "hubtel", buyerPhone: s.dialingPhone }
}

type Categories = Extract<BotCatalogResult, { ok: true }>["categories"]

async function loadCatalog(ctx: FlowCtx, network: BundleNetwork): Promise<{ ok: true; categories: Categories } | { ok: false; status: number }> {
  const bc = botContext(ctx.session)
  if (!bc) return { ok: false, status: 503 }
  try {
    const r = await ctx.deps.networkPlans.catalog(bc, network)
    if (!r.ok) return { ok: false, status: r.status }
    // Non-empty categories in CATEGORY_ORDER; anything unknown ("Other") after, in catalog order.
    const order = CATEGORY_ORDER[network]
    const rank = (n: string) => (order.indexOf(n) === -1 ? order.length : order.indexOf(n))
    const categories = r.categories.filter(c => c.bundles.length > 0)
      .map((c, i) => ({ c, i })).sort((a, b) => rank(a.c.name) - rank(b.c.name) || a.i - b.i).map(x => x.c)
    return { ok: true, categories }
  } catch (e) {
    console.error("[HUBTEL-NP] catalog failed:", e instanceof Error ? e.message : "error")
    return { ok: false, status: 503 }
  }
}

const toPlan = (b: Categories[number]["bundles"][number]): NpPlan => ({ t: b.token, d: b.display, f: b.amount, p: b.payAmount })

/** Back out of the flow: main menu (main mode) or the shop's product menu (shop mode). */
const leave = (ctx: FlowCtx, prefix = "") => (ctx.session.mode === "shop" ? backToProduct(ctx, prefix) : backToMain(ctx))

export async function startNetworkPlans(ctx: FlowCtx): Promise<HubtelReply> {
  return goto(ctx, { step: "NP_NETWORK" }, networkScreen(), NETWORK)
}

async function selectNetwork(ctx: FlowCtx): Promise<HubtelReply> {
  if (ctx.input === "0") return leave(ctx)
  const network = /^\d$/.test(ctx.input) ? NETWORKS[Number(ctx.input) - 1] : undefined
  if (!network) return say(ctx, networkScreen(), "NP_NETWORK", NETWORK)
  return showCategories(ctx, network)
}

async function showCategories(ctx: FlowCtx, network: BundleNetwork, prefix = ""): Promise<HubtelReply> {
  const c = await loadCatalog(ctx, network)
  if (!c.ok && c.status !== 403) return finish(ctx, NP_TEXT.unavailable)
  if (!c.ok || c.categories.length === 0) {
    return goto(ctx, { step: "NP_NETWORK" }, networkScreen(`${NETWORK_LABEL[network]}: ${NP_TEXT.notAvailable}\n`), NETWORK)
  }
  const names = c.categories.map(x => x.name)
  return goto(ctx, { step: "NP_CATEGORY", npNetwork: network, npCategories: names }, categoryScreen(network, names, prefix), CATEGORY)
}

/** Load `page` of the session's category (fresh tokens) and show it; the page's tokens go in the session. */
async function showPlans(ctx: FlowCtx, category: string, page: number): Promise<HubtelReply> {
  const network = ctx.session.npNetwork!
  const c = await loadCatalog(ctx, network)
  if (!c.ok && c.status !== 403) return finish(ctx, NP_TEXT.unavailable)
  const bundles = c.ok ? c.categories.find(x => x.name === category)?.bundles ?? [] : []
  if (bundles.length === 0) return showCategories(ctx, network, `${NP_TEXT.notAvailable}\n`)
  const slice = pageSlice(bundles.map(toPlan), page, NP_PAGE_SIZE)
  return goto(ctx, { step: "NP_PLAN", npCategory: category, npPage: slice.page, npPlans: slice.items, npPlan: undefined },
    planScreen(network, category, slice.items, slice.hasNext), PLAN)
}

async function selectCategory(ctx: FlowCtx): Promise<HubtelReply> {
  const s = ctx.session
  if (ctx.input === "0") return goto(ctx, { step: "NP_NETWORK" }, networkScreen(), NETWORK)
  const names = s.npCategories ?? []
  const name = /^\d+$/.test(ctx.input) ? names[Number(ctx.input) - 1] : undefined
  if (!name) return say(ctx, categoryScreen(s.npNetwork!, names), "NP_CATEGORY", CATEGORY)
  return showPlans(ctx, name, 0)
}

async function selectPlan(ctx: FlowCtx): Promise<HubtelReply> {
  const s = ctx.session
  const page = s.npPage ?? 0
  const plans = s.npPlans ?? []
  if (ctx.input === "00") {
    if (page > 0) return showPlans(ctx, s.npCategory!, page - 1)
    return goto(ctx, { step: "NP_CATEGORY", npPlans: undefined }, categoryScreen(s.npNetwork!, s.npCategories ?? []), CATEGORY)
  }
  // "0" = next page (showPlans clamps to the last page, so "0" on the last page just repaints it).
  if (ctx.input === "0") return showPlans(ctx, s.npCategory!, page + 1)
  const plan = /^\d$/.test(ctx.input) ? plans[Number(ctx.input) - 1] : undefined
  if (!plan) return showPlans(ctx, s.npCategory!, page)
  return goto(ctx, { step: "NP_RECIPIENT", npPlan: plan, npOtherNumber: false }, recipientScreen(s), RECIPIENT)
}

/** Number + network prefix check (admin-toggleable map), as the engine will re-check it. */
async function recipientProblem(ctx: FlowCtx, local: string): Promise<string | null> {
  if (!/^0[0-9]{9}$/.test(local)) return "Invalid number. Enter a valid Ghana phone number."
  const prefix = await ctx.deps.getPrefixConfig()
  if (prefix.enabled && ctx.session.npNetwork) {
    const check = validateNetworkPrefix(ctx.session.npNetwork, local, prefix.map)
    if (!check.ok) return check.message ?? "Number does not match the selected network."
  }
  return null
}

// Standard Bundles have their own suppliers: no MTN number check, only the Standard Bundles delivery time.
async function toConfirm(ctx: FlowCtx, local: string): Promise<HubtelReply> {
  const note = await confirmNote(ctx, { network: ctx.session.npNetwork, recipientLocal: local, verify: false, estimate: "standard" })
  return goto(ctx, { step: "NP_CONFIRM", npRecipient: local, npOtherNumber: false, confirmNote: note }, networkPlanConfirmText(ctx.session.npPlan!, local, note, npLabel(ctx.session)), CONFIRM)
}

async function enterRecipient(ctx: FlowCtx): Promise<HubtelReply> {
  const s = ctx.session
  const { input } = ctx
  if (s.npOtherNumber) {
    if (input === "0") return goto(ctx, { step: "NP_RECIPIENT", npOtherNumber: false }, recipientScreen(s), RECIPIENT)
    const local = toLocalPhone(input.replace(/\s+/g, ""))
    const problem = await recipientProblem(ctx, local)
    if (problem) return say(ctx, otherScreen(problem + "\n"), "NP_RECIPIENT", OTHER)
    return toConfirm(ctx, local)
  }
  if (input === "0") return showPlans(ctx, s.npCategory!, s.npPage ?? 0)
  if (input === "2") return goto(ctx, { step: "NP_RECIPIENT", npOtherNumber: true }, otherScreen(), OTHER)
  if (input !== "1") return say(ctx, recipientScreen(s), "NP_RECIPIENT", RECIPIENT)
  const own = toLocalPhone(s.dialingPhone)
  const problem = await recipientProblem(ctx, own)
  if (problem) return say(ctx, recipientScreen(s, problem + "\n"), "NP_RECIPIENT", RECIPIENT)
  return toConfirm(ctx, own)
}

/** Engine idempotency key: the Hubtel session id (or a stable hash when it is not key-shaped). */
export function npIdempotencyKey(sessionId: string): string {
  return isValidIdempotencyKey(sessionId) ? sessionId : crypto.createHash("sha256").update(sessionId).digest("hex")
}

async function confirm(ctx: FlowCtx): Promise<HubtelReply> {
  const { input, deps, req, session } = ctx
  if (input === "0") return finish(ctx, "Order cancelled.")
  if (input !== "1") return say(ctx, networkPlanConfirmText(session.npPlan!, session.npRecipient!, session.confirmNote, npLabel(session)), "NP_CONFIRM", CONFIRM)

  const replay = await replaySubmittedOrder(deps, req.SessionId, req.Platform)
  if (replay) return replay

  const bc = botContext(session)
  const plan = session.npPlan
  if (!bc || !plan || !session.npRecipient) return finish(ctx, NP_TEXT.unavailable)

  const key = npIdempotencyKey(req.SessionId)
  let r
  try {
    r = await deps.networkPlans.createOrder(bc, { token: plan.t, recipient: session.npRecipient, idempotencyKey: key, expectedPay: plan.p })
  } catch (e) {
    console.error("[HUBTEL-NP] createOrder threw:", e instanceof Error ? e.message : "error", "session:", req.SessionId)
    // It may have committed before throwing: an order under this key would sit pending + unpaid with no checkout.
    const orphan = await deps.networkPlans.findOrderId(bc, key).catch((err: unknown) => {
      console.error("[HUBTEL-NP] orphan lookup failed:", err instanceof Error ? err.message : "error", "session:", req.SessionId)
      return null
    })
    if (orphan) await failOrphanEngineOrder(deps, "hubtel_data_orders", orphan, "HUBTEL-NP", req.SessionId)
    return finish(ctx, NP_TEXT.unavailable)
  }
  if (!r.ok) {
    if (r.status === 409) return finish(ctx, NP_TEXT.priceChanged)
    if (r.status === 429) return finish(ctx, NP_TEXT.tooMany)
    if (r.status === 403) return finish(ctx, NP_TEXT.notAvailable)
    return finish(ctx, NP_TEXT.unavailable)
  }
  // The engine may hand back an existing order for this key: only a still-open one (pending + unpaid) is carted.
  const { data: row, error } = await deps.supabase
    .from("hubtel_data_orders").select("status, payment_status").eq("id", r.order.id).maybeSingle()
  const open = row as { status?: string; payment_status?: string } | null
  if (error || open?.status !== "pending" || open?.payment_status !== "unpaid") {
    console.error("[HUBTEL-NP] Engine order is not open; refusing to cart:", r.order.id, open?.status ?? null, open?.payment_status ?? null, "session:", req.SessionId)
    // Read error / no row: its state is unknown, so fail it (guarded: only a still pending + unpaid bots row is
    // touched). A row read as not open is already paid or closed: the guarded patch could not touch it anyway.
    if (error || !open) await failOrphanEngineOrder(deps, "hubtel_data_orders", r.order.id, "HUBTEL-NP", req.SessionId)
    return finish(ctx, NP_TEXT.unavailable)
  }
  return submitOrder(ctx, { table: "hubtel_data_orders", orderId: r.order.id, price: r.order.payAmount, logTag: "HUBTEL-NP" })
}

export const NETWORK_PLANS_STEPS: StepTable = {
  NP_NETWORK: selectNetwork,
  NP_CATEGORY: selectCategory,
  NP_PLAN: selectPlan,
  NP_RECIPIENT: enterRecipient,
  NP_CONFIRM: confirm,
}
