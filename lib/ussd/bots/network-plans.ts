// "Network Plans" (Commission Cashback bots): Hubtel Standard Bundles sold, priced by the bot engine on rail paystack.
// - Uzo menus: the main USSD (surface "ussd", no shop) and the shop USSD (surface "ussd_shop", the session's resolved
//   shop); paid by a MoMo prompt to the dialing number only. Every Hubtel name shown is rewritten by uzoSafeLabel
//   (Uzo wording rule: no "data" / "bundle" words) and networks show their Uzo nicknames (UZO_PROFILE).
// - WhatsApp bots ("whatsapp" / "whatsapp_shop", WHATSAPP_PROFILE): names as Hubtel sends them, 10 per page, and the
//   buyer types the MoMo number to charge (NP_PAY_PHONE, before confirm); NEEDS_VERIFY => SMS check (NP_PAY_VERIFY).
// Pattern: lib/ussd-hubtel/flows/network-plans.ts.
import crypto from "crypto"
import { botCatalog, type BotCatalogResult } from "@/lib/bot-commission/catalog"
import { resolveBotContext, type BotContext } from "@/lib/bot-commission/context"
import { botChargeMomo, getBotMomoRuntime } from "@/lib/bot-commission/momo"
import { failBotCharge } from "@/lib/bot-commission/momo-fail"
import { botCreateBundleOrder, type BotBundleOrderInput, type BotOrderResult } from "@/lib/bot-commission/orders"
import { sendPayerOtp, verifyPayerOtp } from "@/lib/bot-commission/payer-verify"
import { getBotBundlesRuntime } from "@/lib/bot-commission/runtime"
import { getPrefixValidationConfig, type PrefixValidationConfig } from "@/lib/network-prefix-config"
import { normalizeGhanaPhone, validateNetworkPrefix } from "@/lib/phone-format"
import { CATEGORY_ORDER, type BundleNetwork } from "@/lib/standard-bundles/categories"
import { isValidIdempotencyKey, PRICES_REFRESHED } from "@/lib/standard-bundles/service"
import { networkNickname } from "../network-labels"
import type { UzoNpPlan, UzoResponse } from "../types"
import {
  botFlowChargeOrder, botFlowContext, botRestartText, flowProfile, liveUzoBotIo, parsePayPhone, payerVerifyStep,
  samePrice, startPayerVerify, uzoBotClosedSession, uzoShopHeader, withoutBotFields, PAY_PHONE_INVALID, PAY_PHONE_PROMPT,
  UZO_BOT_UNAVAILABLE, type BotFlowCtx, type UzoBotCtx, type UzoBotIo, type UzoBotPayDeps, type UzoBotSession,
} from "./kit"
import { UZO_PROFILE, type BotFlowProfile } from "./profile"
import { botErrorText, uzoConfirmText, uzoPagedList } from "./screen"

export type { UzoBotCtx, UzoBotSession } from "./kit"

/** Uzo page size (the WhatsApp profile pages 10). */
export const NP_PAGE_SIZE = UZO_PROFILE.pageSize
const TAG = "USSD-NP"
const NETWORKS: readonly BundleNetwork[] = ["MTN", "TELECEL", "AT"]
/** Engine network => the Uzo nickname key (lib/ussd/network-labels.ts). */
const NICK_KEY: Record<BundleNetwork, string> = { MTN: "MTN", TELECEL: "Telecel", AT: "AT" }
export const npNickname = (n: BundleNetwork): string => networkNickname(NICK_KEY[n])
/** WhatsApp shows the networks by name. */
const WA_NETWORK: Record<BundleNetwork, string> = { MTN: "MTN", TELECEL: "Telecel", AT: "AT" }
const networkName = (p: BotFlowProfile, n: BundleNetwork) => (p.kind === "whatsapp" ? WA_NETWORK[n] : npNickname(n))

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

const money = (n: number) => n.toFixed(2)

// ── Screens ──────────────────────────────────────────────────────────────────

function networkScreen(ctx: BotFlowCtx, p: BotFlowProfile, prefix = ""): string {
  const lines = NETWORKS.map((n, i) => `${i + 1}. ${networkName(p, n)}`).join("\n")
  return `${prefix}${uzoShopHeader(ctx)}Network Plans\n${lines}\n0. Back`
}

function categoryScreen(p: BotFlowProfile, network: BundleNetwork, names: string[], prefix = ""): string {
  return uzoPagedList(names, 0, p.label, {
    header: `${prefix}${networkName(p, network)}\nSelect type:`, pageSize: Math.max(1, names.length), limit: p.limit,
  }).text
}

/** Price first (no "GHS " so the name gets the room): a long plan name is shortened on a word, never the price. */
const planLabel = (p: BotFlowProfile) => (plan: UzoNpPlan) => `${money(plan.p)} ${p.label(plan.d)}`

function recipientScreen(ctx: BotFlowCtx, prefix = ""): string {
  return `${prefix}${uzoShopHeader(ctx)}Recipient:\n1. My number\n2. Other number\n0. Back`
}

const otherScreen = (prefix = "") => `${prefix}Enter recipient number:\n\n0. Back`
const payPhoneScreen = (prefix = "") => `${prefix}${PAY_PHONE_PROMPT}`

/**
 * Confirm: price (was face), what is received, the recipient, the paying number. Uzo: the dialling number pays.
 * WhatsApp: `payPhone`, the MoMo number the buyer typed.
 */
export function npConfirmScreen(ctx: BotFlowCtx, network: BundleNetwork, plan: UzoNpPlan, recipient: string, payPhone?: string): string {
  const p = flowProfile(ctx) ?? UZO_PROFILE
  const payer = p.askPayPhone ? payPhone ?? "" : normalizeGhanaPhone(ctx.dialingPhone) ?? ctx.dialingPhone
  const body = uzoConfirmText({
    pay: plan.p, face: plan.f, receive: `${networkName(p, network)} ${p.label(plan.d)}`, recipient, payer, limit: p.limit,
  })
  const head = uzoShopHeader(ctx)
  return head && (head + body).length <= p.limit ? head + body : body
}

// ── Catalog ──────────────────────────────────────────────────────────────────

type Categories = Extract<BotCatalogResult, { ok: true }>["categories"]

async function loadCatalog(
  d: NetworkPlansDeps, ctx: BotFlowCtx, network: BundleNetwork,
): Promise<{ ok: true; categories: Categories } | { ok: false; status: number }> {
  const bc = botFlowContext(ctx)
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

type Step = { ctx: BotFlowCtx; p: BotFlowProfile; input: string; s: UzoBotSession; d: NetworkPlansDeps }

async function goto(x: Step, patch: Partial<UzoBotSession> & { step: UzoBotSession["step"] }, text: string): Promise<UzoResponse> {
  await x.d.io.save(x.ctx.sessionId, { ...x.s, ...patch } as UzoBotSession)
  return x.d.io.cont(text)
}

export async function startNetworkPlans(
  ctx: BotFlowCtx, session: UzoBotSession, d: NetworkPlansDeps = liveNetworkPlansDeps(ctx.surface),
): Promise<UzoResponse> {
  const p = flowProfile(ctx)
  if (!p || !botFlowContext(ctx)) return d.io.end(UZO_BOT_UNAVAILABLE) // shop without a resolved shop: fail closed
  if (session.dataBlocked === true) return d.io.end(NP_TEXT.notAvailable) // data whitelist (as Browse Services)
  await d.io.save(ctx.sessionId, { ...withoutBotFields(session), step: "NP_NETWORK" } as UzoBotSession)
  return d.io.cont(networkScreen(ctx, p))
}

export async function handleNetworkPlansStep(
  ctx: BotFlowCtx, input: string, session: UzoBotSession, d: NetworkPlansDeps = liveNetworkPlansDeps(ctx.surface),
): Promise<UzoResponse> {
  const p = flowProfile(ctx)
  if (!p || !botFlowContext(ctx)) return d.io.end(UZO_BOT_UNAVAILABLE)
  const x: Step = { ctx, p, input: (input ?? "").trim(), s: session, d }
  // Data whitelist: a blocked caller never gets here from the menu; a stale / crafted session is refused.
  if (session.dataBlocked === true) return d.io.end(NP_TEXT.notAvailable)
  switch (session.step) {
    case "NP_NETWORK": return selectNetwork(x)
    case "NP_CATEGORY": return selectCategory(x)
    case "NP_PLAN": return selectPlan(x)
    case "NP_RECIPIENT": return enterRecipient(x)
    case "NP_PAY_PHONE": return p.askPayPhone ? enterPayPhone(x) : d.io.leave(ctx, session)
    case "NP_CONFIRM": return confirm(x)
    case "NP_PAY_VERIFY": return p.askPayPhone ? payVerify(x) : d.io.leave(ctx, session)
    default: return d.io.leave(ctx, session)
  }
}

async function selectNetwork(x: Step): Promise<UzoResponse> {
  if (x.input === "0") return x.d.io.leave(x.ctx, withoutBotFields(x.s))
  const network = /^\d$/.test(x.input) ? NETWORKS[Number(x.input) - 1] : undefined
  if (!network) return goto(x, { step: "NP_NETWORK" }, networkScreen(x.ctx, x.p))
  return showCategories(x, network)
}

async function showCategories(x: Step, network: BundleNetwork, prefix = ""): Promise<UzoResponse> {
  const c = await loadCatalog(x.d, x.ctx, network)
  if (!c.ok && c.status !== 403) return x.d.io.end(botErrorText(c.status))
  if (!c.ok || c.categories.length === 0) {
    return goto(x, { step: "NP_NETWORK" }, networkScreen(x.ctx, x.p, `${NP_TEXT.notAvailable}\n`))
  }
  const names = c.categories.map(k => k.name)
  return goto(x, { step: "NP_CATEGORY", npNetwork: network, npCategories: names, npPlans: undefined, npPlan: undefined },
    categoryScreen(x.p, network, names, prefix))
}

/** Load the category (fresh signed tokens) and show `page`, clamped into range; only that page's plans are kept. */
async function showPlans(x: Step, category: string, page: number): Promise<UzoResponse> {
  const network = x.s.npNetwork
  if (!network) return goto(x, { step: "NP_NETWORK" }, networkScreen(x.ctx, x.p))
  const c = await loadCatalog(x.d, x.ctx, network)
  if (!c.ok && c.status !== 403) return x.d.io.end(botErrorText(c.status))
  const bundles = c.ok ? c.categories.find(k => k.name === category)?.bundles ?? [] : []
  if (bundles.length === 0) return showCategories(x, network, `${NP_TEXT.notAvailable}\n`)
  const plans = bundles.map(toPlan)
  const size = x.p.pageSize
  const last = Math.ceil(plans.length / size) - 1
  const p = Math.min(Math.max(0, Number.isFinite(page) ? Math.floor(page) : 0), last)
  const header = `${networkName(x.p, network)} ${x.p.label(category)}`.slice(0, x.p.kind === "whatsapp" ? 100 : 30).trim()
  const list = uzoPagedList(plans, p, planLabel(x.p), { header, pageSize: size, limit: x.p.limit })
  return goto(x, { step: "NP_PLAN", npCategory: category, npPage: p, npPlans: list.pageItems, npPlan: undefined }, list.text)
}

async function selectCategory(x: Step): Promise<UzoResponse> {
  if (x.input === "0") return goto(x, { step: "NP_NETWORK", npNetwork: undefined, npCategories: undefined }, networkScreen(x.ctx, x.p))
  const names = x.s.npCategories ?? []
  const name = /^\d+$/.test(x.input) ? names[Number(x.input) - 1] : undefined
  if (!name || !x.s.npNetwork) {
    if (!x.s.npNetwork || names.length === 0) return goto(x, { step: "NP_NETWORK" }, networkScreen(x.ctx, x.p))
    return goto(x, { step: "NP_CATEGORY" }, categoryScreen(x.p, x.s.npNetwork, names))
  }
  return showPlans(x, name, 0)
}

async function selectPlan(x: Step): Promise<UzoResponse> {
  const page = x.s.npPage ?? 0
  const plans = x.s.npPlans ?? []
  const category = x.s.npCategory
  if (!category || !x.s.npNetwork) return goto(x, { step: "NP_NETWORK" }, networkScreen(x.ctx, x.p))
  if (x.input === "0") {
    if (page > 0) return showPlans(x, category, page - 1)
    return goto(x, { step: "NP_CATEGORY", npPlans: undefined, npPage: undefined }, categoryScreen(x.p, x.s.npNetwork, x.s.npCategories ?? []))
  }
  const offset = page * x.p.pageSize
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

/** Recipient chosen: Uzo => confirm; WhatsApp => the MoMo number to charge first. */
async function toConfirm(x: Step, local: string): Promise<UzoResponse> {
  if (x.p.askPayPhone) {
    return goto(x, { step: "NP_PAY_PHONE", npRecipient: local, npOtherNumber: false, npPayPhone: undefined }, payPhoneScreen())
  }
  return goto(x, { step: "NP_CONFIRM", npRecipient: local, npOtherNumber: false },
    npConfirmScreen(x.ctx, x.s.npNetwork!, x.s.npPlan!, local))
}

async function enterRecipient(x: Step): Promise<UzoResponse> {
  const { s } = x
  if (!s.npPlan || !s.npNetwork) return goto(x, { step: "NP_NETWORK" }, networkScreen(x.ctx, x.p))
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

/** WhatsApp: the MoMo number to charge (never the sender's own number unless typed). */
async function enterPayPhone(x: Step): Promise<UzoResponse> {
  const { s } = x
  if (!s.npPlan || !s.npNetwork || !s.npRecipient) return goto(x, { step: "NP_NETWORK" }, networkScreen(x.ctx, x.p))
  if (x.input === "0") return goto(x, { step: "NP_RECIPIENT", npOtherNumber: false, npRecipient: undefined, npPayPhone: undefined }, recipientScreen(x.ctx))
  const pay = parsePayPhone(x.input)
  if (!pay) return goto(x, { step: "NP_PAY_PHONE", npPayPhone: undefined }, payPhoneScreen(`${PAY_PHONE_INVALID}\n`))
  return goto(x, { step: "NP_CONFIRM", npPayPhone: pay }, npConfirmScreen(x.ctx, s.npNetwork, s.npPlan, s.npRecipient, pay))
}

/** Engine idempotency key: the Uzo session id (or a stable hash when it is not key-shaped). */
export function uzoNpIdempotencyKey(sessionId: string): string {
  return isValidIdempotencyKey(sessionId) ? sessionId : crypto.createHash("sha256").update(sessionId).digest("hex")
}

async function confirm(x: Step): Promise<UzoResponse> {
  const { s, d, ctx, p } = x
  const plan = s.npPlan
  const recipient = s.npRecipient
  if (!plan || !recipient || !s.npNetwork) return goto(x, { step: "NP_NETWORK" }, networkScreen(ctx, p))
  // WhatsApp: no paying number yet (stale / crafted session) => ask for it, never charge the sender by default.
  const payPhone = p.askPayPhone ? s.npPayPhone : undefined
  if (p.askPayPhone && !payPhone) return goto(x, { step: "NP_PAY_PHONE" }, payPhoneScreen())
  if (x.input === "2") return d.io.end(NP_TEXT.cancelled)
  if (x.input === "0") {
    if (p.askPayPhone) return goto(x, { step: "NP_PAY_PHONE", npPayPhone: undefined }, payPhoneScreen())
    return goto(x, { step: "NP_RECIPIENT", npOtherNumber: false, npRecipient: undefined }, recipientScreen(ctx))
  }
  if (x.input !== "1") return goto(x, { step: "NP_CONFIRM" }, npConfirmScreen(ctx, s.npNetwork, plan, recipient, payPhone))

  const bc = botFlowContext(ctx)
  if (!bc) return d.io.end(UZO_BOT_UNAVAILABLE)
  const key = uzoNpIdempotencyKey(ctx.sessionId)
  // Close the flow BEFORE the engine call (whatever it answers, or if it throws): the plan tokens are gone from the
  // session, so no back-navigation on it can reach a confirm and create a second order.
  const closed = uzoBotClosedSession(ctx, s)
  await d.io.save(ctx.sessionId, closed)
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
  if (!r.ok) {
    // The catalog token expired (or no longer verifies) between the plan list and confirm: only a new list helps.
    if (r.status === 409 && r.error === PRICES_REFRESHED) return d.io.end(botRestartText(p))
    return d.io.end(botErrorText(r.status))
  }
  // An engine replay under a reused key hands back an older order: never charge a price the screen did not show.
  if (!samePrice(r.order.payAmount, plan.p)) {
    console.error(`[${TAG}] engine order price differs from the confirm screen; refusing to charge:`, r.order.id)
    return d.io.end(botErrorText(409))
  }
  const out = await botFlowChargeOrder(d, ctx, "cs_bundle", r.order.id, TAG, payPhone)
  if (out.kind === "end") return d.io.end(out.text)
  // WhatsApp NEEDS_VERIFY: the order stays open; only its id and the paying number are kept (no token, no plan).
  const sent = await startPayerVerify(d, ctx, r.order.id, payPhone!, TAG)
  if (!sent.ok) return d.io.end(sent.text)
  await d.io.save(ctx.sessionId, { ...closed, step: "NP_PAY_VERIFY", npOrderId: r.order.id, npPayPhone: payPhone } as UzoBotSession)
  return d.io.cont(sent.text)
}

/** WhatsApp NP_PAY_VERIFY: the SMS code for the paying number; verified => the SAME order is charged again. */
async function payVerify(x: Step): Promise<UzoResponse> {
  const { s, d, ctx } = x
  const closed = uzoBotClosedSession(ctx, s)
  if (!s.npOrderId || !s.npPayPhone) {
    await d.io.save(ctx.sessionId, closed)
    return d.io.end(UZO_BOT_UNAVAILABLE)
  }
  const r = await payerVerifyStep(d, ctx, x.input, "cs_bundle", s.npOrderId, s.npPayPhone, TAG)
  if (r.kind === "retry") return goto(x, { step: "NP_PAY_VERIFY" }, r.text)
  await d.io.save(ctx.sessionId, closed)
  return d.io.end(r.text)
}

// ── Live wiring ──────────────────────────────────────────────────────────────

let runtime: ReturnType<typeof getBotBundlesRuntime> | null = null
const bundles = () => (runtime ??= getBotBundlesRuntime())

/** Live deps. The Uzo menus use their own io; a WhatsApp surface must pass the bot's io (there is no default). */
export function liveNetworkPlansDeps(surface: BotFlowCtx["surface"], io: UzoBotIo = liveUzoBotIo(surface)): NetworkPlansDeps {
  return {
    io,
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
    payer: { send: sendPayerOtp, verify: verifyPayerOtp },
    getPrefixConfig: getPrefixValidationConfig,
  }
}
