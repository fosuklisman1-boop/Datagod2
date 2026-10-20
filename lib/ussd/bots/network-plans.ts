// "Network Plans" (Commission Cashback bots) on the Uzo menus: Hubtel Standard Bundles sold on the main USSD
// (surface "ussd", no shop) and the shop USSD (surface "ussd_shop", the session's resolved shop), priced by the
// bot engine on rail paystack and paid by a MoMo prompt to the dialing number only.
// Pattern: lib/ussd-hubtel/flows/network-plans.ts. Unlike Hubtel, every Hubtel name shown here is rewritten by
// uzoSafeLabel (Uzo wording rule: no "data" / "bundle" words) and networks show their Uzo nicknames.
import crypto from "crypto"
import { botCatalog, type BotCatalogResult } from "@/lib/bot-commission/catalog"
import { resolveBotContext, type BotContext } from "@/lib/bot-commission/context"
import { botChargeMomo, getBotMomoRuntime } from "@/lib/bot-commission/momo"
import { failBotCharge } from "@/lib/bot-commission/momo-fail"
import { botCreateBundleOrder, type BotBundleOrderInput, type BotOrderResult } from "@/lib/bot-commission/orders"
import { getBotBundlesRuntime } from "@/lib/bot-commission/runtime"
import { getPrefixValidationConfig, type PrefixValidationConfig } from "@/lib/network-prefix-config"
import { normalizeGhanaPhone, validateNetworkPrefix } from "@/lib/phone-format"
import { CATEGORY_ORDER, type BundleNetwork } from "@/lib/standard-bundles/categories"
import { isValidIdempotencyKey } from "@/lib/standard-bundles/service"
import { networkNickname } from "../network-labels"
import type { UzoNpPlan, UzoResponse } from "../types"
import {
  ascii, liveUzoBotIo, samePrice, uzoBotContext, uzoChargeOrder, uzoShopHeader, withoutBotFields, UZO_BOT_UNAVAILABLE,
  type UzoBotCtx, type UzoBotIo, type UzoBotPayDeps, type UzoBotSession,
} from "./kit"
import { botErrorText, fitsUzo, uzoConfirmText, uzoPagedList, uzoSafeLabel } from "./screen"

export type { UzoBotCtx, UzoBotSession } from "./kit"

export const NP_PAGE_SIZE = 5
const TAG = "USSD-NP"
const NETWORKS: readonly BundleNetwork[] = ["MTN", "TELECEL", "AT"]
/** Engine network => the Uzo nickname key (lib/ussd/network-labels.ts). */
const NICK_KEY: Record<BundleNetwork, string> = { MTN: "MTN", TELECEL: "Telecel", AT: "AT" }
export const npNickname = (n: BundleNetwork): string => networkNickname(NICK_KEY[n])

export const NP_TEXT = {
  notAvailable: botErrorText(403),
  badNumber: "Invalid number.",
  wrongNetwork: "Number does not match network.",
  cancelled: "Order cancelled.",
} as const

/** Everything the flow touches outside itself (live wiring below; tests inject fakes). */
export interface NetworkPlansDeps extends UzoBotPayDeps {
  io: UzoBotIo
  catalog(bc: BotContext, network: BundleNetwork): Promise<BotCatalogResult>
  createOrder(bc: BotContext, input: BotBundleOrderInput): Promise<BotOrderResult>
  /** The bot order already created under this idempotency key (orphan check after a throw), or null. */
  findOrderId(bc: BotContext, idempotencyKey: string): Promise<string | null>
  getPrefixConfig(): Promise<PrefixValidationConfig>
}

const label = (s: string) => ascii(uzoSafeLabel(s))
const money = (n: number) => n.toFixed(2)

// ── Screens ──────────────────────────────────────────────────────────────────

function networkScreen(ctx: UzoBotCtx, prefix = ""): string {
  const lines = NETWORKS.map((n, i) => `${i + 1}. ${npNickname(n)}`).join("\n")
  return `${prefix}${uzoShopHeader(ctx)}Network Plans\n${lines}\n0. Back`
}

function categoryScreen(network: BundleNetwork, names: string[], prefix = ""): string {
  return uzoPagedList(names, 0, label, { header: `${prefix}${npNickname(network)}\nSelect type:`, pageSize: Math.max(1, names.length) }).text
}

/** Price first (no "GHS " so the name gets the room): a long plan name is shortened on a word, never the price. */
const planLabel = (p: UzoNpPlan) => `${money(p.p)} ${label(p.d)}`

function recipientScreen(ctx: UzoBotCtx, prefix = ""): string {
  return `${prefix}${uzoShopHeader(ctx)}Recipient:\n1. My number\n2. Other number\n0. Back`
}

const otherScreen = (prefix = "") => `${prefix}Enter recipient number:\n\n0. Back`

export function npConfirmScreen(ctx: UzoBotCtx, network: BundleNetwork, plan: UzoNpPlan, recipient: string): string {
  const body = uzoConfirmText({
    pay: plan.p, face: plan.f, receive: `${npNickname(network)} ${label(plan.d)}`,
    recipient, payer: normalizeGhanaPhone(ctx.dialingPhone) ?? ctx.dialingPhone,
  })
  const head = uzoShopHeader(ctx)
  return head && fitsUzo(head + body) ? head + body : body
}

// ── Catalog ──────────────────────────────────────────────────────────────────

type Categories = Extract<BotCatalogResult, { ok: true }>["categories"]

async function loadCatalog(
  d: NetworkPlansDeps, ctx: UzoBotCtx, network: BundleNetwork,
): Promise<{ ok: true; categories: Categories } | { ok: false; status: number }> {
  const bc = uzoBotContext(ctx)
  if (!bc) return { ok: false, status: 503 }
  try {
    const r = await d.catalog(bc, network)
    if (!r.ok) return { ok: false, status: r.status }
    // Non-empty categories in CATEGORY_ORDER; anything unknown after, in catalog order.
    const order = CATEGORY_ORDER[network]
    const rank = (n: string) => (order.indexOf(n) === -1 ? order.length : order.indexOf(n))
    const categories = r.categories.filter(c => c.bundles.length > 0)
      .map((c, i) => ({ c, i })).sort((a, b) => rank(a.c.name) - rank(b.c.name) || a.i - b.i).map(x => x.c)
    return { ok: true, categories }
  } catch (e) {
    console.error(`[${TAG}] catalog failed:`, e instanceof Error ? e.message : "error")
    return { ok: false, status: 503 }
  }
}

const toPlan = (b: Categories[number]["bundles"][number]): UzoNpPlan => ({ t: b.token, d: b.display, f: b.amount, p: b.payAmount })

// ── Flow ─────────────────────────────────────────────────────────────────────

type Step = { ctx: UzoBotCtx; input: string; s: UzoBotSession; d: NetworkPlansDeps }

async function goto(x: Step, patch: Partial<UzoBotSession> & { step: UzoBotSession["step"] }, text: string): Promise<UzoResponse> {
  await x.d.io.save(x.ctx.sessionId, { ...x.s, ...patch } as UzoBotSession)
  return x.d.io.cont(text)
}

export async function startNetworkPlans(
  ctx: UzoBotCtx, session: UzoBotSession, d: NetworkPlansDeps = liveNetworkPlansDeps(ctx.surface),
): Promise<UzoResponse> {
  if (!uzoBotContext(ctx)) return d.io.end(UZO_BOT_UNAVAILABLE) // shop menu without a resolved shop: fail closed
  await d.io.save(ctx.sessionId, { ...withoutBotFields(session), step: "NP_NETWORK" } as UzoBotSession)
  return d.io.cont(networkScreen(ctx))
}

export async function handleNetworkPlansStep(
  ctx: UzoBotCtx, input: string, session: UzoBotSession, d: NetworkPlansDeps = liveNetworkPlansDeps(ctx.surface),
): Promise<UzoResponse> {
  const x: Step = { ctx, input: (input ?? "").trim(), s: session, d }
  if (!uzoBotContext(ctx)) return d.io.end(UZO_BOT_UNAVAILABLE)
  switch (session.step) {
    case "NP_NETWORK": return selectNetwork(x)
    case "NP_CATEGORY": return selectCategory(x)
    case "NP_PLAN": return selectPlan(x)
    case "NP_RECIPIENT": return enterRecipient(x)
    case "NP_CONFIRM": return confirm(x)
    default: return d.io.leave(ctx, session)
  }
}

async function selectNetwork(x: Step): Promise<UzoResponse> {
  if (x.input === "0") return x.d.io.leave(x.ctx, withoutBotFields(x.s))
  const network = /^\d$/.test(x.input) ? NETWORKS[Number(x.input) - 1] : undefined
  if (!network) return goto(x, { step: "NP_NETWORK" }, networkScreen(x.ctx))
  return showCategories(x, network)
}

async function showCategories(x: Step, network: BundleNetwork, prefix = ""): Promise<UzoResponse> {
  const c = await loadCatalog(x.d, x.ctx, network)
  if (!c.ok && c.status !== 403) return x.d.io.end(botErrorText(c.status))
  if (!c.ok || c.categories.length === 0) {
    return goto(x, { step: "NP_NETWORK" }, networkScreen(x.ctx, `${NP_TEXT.notAvailable}\n`))
  }
  const names = c.categories.map(k => k.name)
  return goto(x, { step: "NP_CATEGORY", npNetwork: network, npCategories: names, npPlans: undefined, npPlan: undefined },
    categoryScreen(network, names, prefix))
}

/** Load the category (fresh signed tokens) and show `page`, clamped into range; only that page's plans are kept. */
async function showPlans(x: Step, category: string, page: number): Promise<UzoResponse> {
  const network = x.s.npNetwork
  if (!network) return goto(x, { step: "NP_NETWORK" }, networkScreen(x.ctx))
  const c = await loadCatalog(x.d, x.ctx, network)
  if (!c.ok && c.status !== 403) return x.d.io.end(botErrorText(c.status))
  const bundles = c.ok ? c.categories.find(k => k.name === category)?.bundles ?? [] : []
  if (bundles.length === 0) return showCategories(x, network, `${NP_TEXT.notAvailable}\n`)
  const plans = bundles.map(toPlan)
  const last = Math.ceil(plans.length / NP_PAGE_SIZE) - 1
  const p = Math.min(Math.max(0, Number.isFinite(page) ? Math.floor(page) : 0), last)
  const header = `${npNickname(network)} ${label(category)}`.slice(0, 30).trim()
  const list = uzoPagedList(plans, p, planLabel, { header, pageSize: NP_PAGE_SIZE })
  return goto(x, { step: "NP_PLAN", npCategory: category, npPage: p, npPlans: list.pageItems, npPlan: undefined }, list.text)
}

async function selectCategory(x: Step): Promise<UzoResponse> {
  if (x.input === "0") return goto(x, { step: "NP_NETWORK", npNetwork: undefined, npCategories: undefined }, networkScreen(x.ctx))
  const names = x.s.npCategories ?? []
  const name = /^\d+$/.test(x.input) ? names[Number(x.input) - 1] : undefined
  if (!name || !x.s.npNetwork) {
    if (!x.s.npNetwork || names.length === 0) return goto(x, { step: "NP_NETWORK" }, networkScreen(x.ctx))
    return goto(x, { step: "NP_CATEGORY" }, categoryScreen(x.s.npNetwork, names))
  }
  return showPlans(x, name, 0)
}

async function selectPlan(x: Step): Promise<UzoResponse> {
  const page = x.s.npPage ?? 0
  const plans = x.s.npPlans ?? []
  const category = x.s.npCategory
  if (!category || !x.s.npNetwork) return goto(x, { step: "NP_NETWORK" }, networkScreen(x.ctx))
  if (x.input === "0") {
    if (page > 0) return showPlans(x, category, page - 1)
    return goto(x, { step: "NP_CATEGORY", npPlans: undefined, npPage: undefined }, categoryScreen(x.s.npNetwork, x.s.npCategories ?? []))
  }
  const offset = page * NP_PAGE_SIZE
  const n = /^\d+$/.test(x.input) ? Number(x.input) : NaN
  // "More..." is numbered right after this page's plans (showPlans clamps, so past the end it repaints the last page).
  if (n === offset + plans.length + 1) return showPlans(x, category, page + 1)
  const plan = n > offset && n <= offset + plans.length ? plans[n - offset - 1] : undefined
  if (!plan) return showPlans(x, category, page)
  return goto(x, { step: "NP_RECIPIENT", npPlan: plan, npOtherNumber: false, npRecipient: undefined }, recipientScreen(x.ctx))
}

/** Number + network prefix check (admin-toggleable map); the engine re-checks it. */
async function recipientProblem(x: Step, local: string | null): Promise<string | null> {
  if (!local) return NP_TEXT.badNumber
  let prefix: PrefixValidationConfig | null = null
  try { prefix = await x.d.getPrefixConfig() } catch { prefix = null } // the engine still checks it
  if (prefix?.enabled && x.s.npNetwork && !validateNetworkPrefix(x.s.npNetwork, local, prefix.map).ok) return NP_TEXT.wrongNetwork
  return null
}

async function toConfirm(x: Step, local: string): Promise<UzoResponse> {
  return goto(x, { step: "NP_CONFIRM", npRecipient: local, npOtherNumber: false },
    npConfirmScreen(x.ctx, x.s.npNetwork!, x.s.npPlan!, local))
}

async function enterRecipient(x: Step): Promise<UzoResponse> {
  const { s } = x
  if (!s.npPlan || !s.npNetwork) return goto(x, { step: "NP_NETWORK" }, networkScreen(x.ctx))
  if (s.npOtherNumber) {
    if (x.input === "0") return goto(x, { step: "NP_RECIPIENT", npOtherNumber: false }, recipientScreen(x.ctx))
    const local = normalizeGhanaPhone(x.input.replace(/\s+/g, ""))
    const problem = await recipientProblem(x, local)
    if (problem) return goto(x, { step: "NP_RECIPIENT", npOtherNumber: true }, otherScreen(`${problem}\n`))
    return toConfirm(x, local!)
  }
  if (x.input === "0") return showPlans(x, s.npCategory ?? "", s.npPage ?? 0)
  if (x.input === "2") return goto(x, { step: "NP_RECIPIENT", npOtherNumber: true }, otherScreen())
  if (x.input !== "1") return goto(x, { step: "NP_RECIPIENT" }, recipientScreen(x.ctx))
  const own = normalizeGhanaPhone(x.ctx.dialingPhone)
  const problem = await recipientProblem(x, own)
  if (problem) return goto(x, { step: "NP_RECIPIENT" }, recipientScreen(x.ctx, `${problem}\n`))
  return toConfirm(x, own!)
}

/** Engine idempotency key: the Uzo session id (or a stable hash when it is not key-shaped). */
export function uzoNpIdempotencyKey(sessionId: string): string {
  return isValidIdempotencyKey(sessionId) ? sessionId : crypto.createHash("sha256").update(sessionId).digest("hex")
}

async function confirm(x: Step): Promise<UzoResponse> {
  const { s, d, ctx } = x
  const plan = s.npPlan
  const recipient = s.npRecipient
  if (!plan || !recipient || !s.npNetwork) return goto(x, { step: "NP_NETWORK" }, networkScreen(ctx))
  if (x.input === "2") return d.io.end(NP_TEXT.cancelled)
  if (x.input === "0") return goto(x, { step: "NP_RECIPIENT", npOtherNumber: false, npRecipient: undefined }, recipientScreen(ctx))
  if (x.input !== "1") return goto(x, { step: "NP_CONFIRM" }, npConfirmScreen(ctx, s.npNetwork, plan, recipient))

  const bc = uzoBotContext(ctx)
  if (!bc) return d.io.end(UZO_BOT_UNAVAILABLE)
  const key = uzoNpIdempotencyKey(ctx.sessionId)
  let r: BotOrderResult
  try {
    r = await d.createOrder(bc, { token: plan.t, recipient, idempotencyKey: key, expectedPay: plan.p })
  } catch (e) {
    console.error(`[${TAG}] createOrder threw:`, e instanceof Error ? e.message : "error")
    // It may have committed before throwing: an order under this key would sit pending + unpaid, never charged.
    const orphan = await d.findOrderId(bc, key).catch(() => null)
    if (orphan) await d.failOrder(orphan)
    return d.io.end(UZO_BOT_UNAVAILABLE)
  }
  if (!r.ok) return d.io.end(botErrorText(r.status))
  // An engine replay under a reused key hands back an older order: never charge a price the screen did not show.
  if (!samePrice(r.order.payAmount, plan.p)) {
    console.error(`[${TAG}] engine order price differs from the confirm screen; refusing to charge:`, r.order.id)
    return d.io.end(botErrorText(409))
  }
  return d.io.end(await uzoChargeOrder(d, ctx, "cs_bundle", r.order.id, TAG))
}

// ── Live wiring ──────────────────────────────────────────────────────────────

let runtime: ReturnType<typeof getBotBundlesRuntime> | null = null
const bundles = () => (runtime ??= getBotBundlesRuntime())

export function liveNetworkPlansDeps(surface: UzoBotCtx["surface"]): NetworkPlansDeps {
  return {
    io: liveUzoBotIo(surface),
    catalog: (bc, network) => botCatalog(bundles().deps, bc, network),
    createOrder: (bc, input) => botCreateBundleOrder(bundles().deps, bc, input),
    async findOrderId(bc, key) {
      const c = resolveBotContext(bc)
      if (!c.ok) return null
      const row = await bundles().deps.findBotBundleOrder(c.ctx.botSurface, c.ctx.buyerPhone, key)
      return row?.id ?? null
    },
    async readOrder(id) {
      const { data, error } = await bundles().db.from("hubtel_data_orders").select("status, payment_status").eq("id", id).maybeSingle()
      if (error) throw error
      return (data as { status?: string; payment_status?: string } | null) ?? null
    },
    failOrder: (id) => failBotCharge(bundles().db, "cs_bundle", id, null, TAG),
    charge: (i) => botChargeMomo(getBotMomoRuntime(), i),
    getPrefixConfig: getPrefixValidationConfig,
  }
}
