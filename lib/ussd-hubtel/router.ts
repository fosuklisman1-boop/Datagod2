// lib/ussd-hubtel/router.ts
import type { SupabaseClient } from "@supabase/supabase-js"
import type { BundleOption } from "@/lib/ussd/types"
import { keyForDigit } from "@/lib/ussd/menu-items"
import { validateNetworkPrefix } from "@/lib/phone-format"
import { getPrefixValidationConfig, type PrefixValidationConfig } from "@/lib/network-prefix-config"
import { paystackProviderFromPhone } from "@/lib/ussd/paystack-provider"
import { getHubtelUssdConfig, type HubtelUssdConfig } from "./config"
import { sessionStore, type HubtelSessionStore } from "./session"
import { fetchBundles, PAGE_SIZE, resolveCaller, isDataBlocked, priceForTier, type CallerContext } from "./catalog"
import {
  HUBTEL_NETWORKS, resolveMainMenu, mainMenuText, networkMenuText, bundleMenuText,
  recipientPromptText, confirmMenuText, type MainMenuKey,
} from "./menus"
import { addToCart, release, respond, toE164, toLocalPhone } from "./protocol"
import type { HubtelReply, HubtelRequest, HubtelSession, HubtelPlatform } from "./types"

export interface RouterDeps {
  supabase: SupabaseClient
  getConfig(): Promise<HubtelUssdConfig>
  sessions: HubtelSessionStore
  fetchBundles: (network: string, page: number, tier: string, parentShopId?: string) => Promise<{ bundles: BundleOption[]; total: number }>
  resolveCaller: (phone: string) => Promise<CallerContext>
  isDataBlocked: (msisdn: string) => Promise<boolean>
  getPrefixConfig: () => Promise<PrefixValidationConfig>
  pageSize: number
}

export function defaultRouterDeps(supabase: SupabaseClient): RouterDeps {
  return {
    supabase,
    getConfig: () => getHubtelUssdConfig(supabase),
    sessions: sessionStore,
    fetchBundles,
    resolveCaller: phone => resolveCaller(supabase, phone),
    isDataBlocked: msisdn => isDataBlocked(supabase, msisdn),
    getPrefixConfig: getPrefixValidationConfig,
    pageSize: PAGE_SIZE,
  }
}

const UNAVAILABLE = "Service unavailable. Please try again later."

export async function hubtelRouter(req: HubtelRequest, deps: RouterDeps): Promise<HubtelReply> {
  const sid = req.SessionId
  const platform = req.Platform

  if (req.Type === "Timeout") {
    await deps.sessions.del(sid)
    return release(sid, "Session ended.", { platform })
  }

  const config = await deps.getConfig()
  // Shop mode ships in a later plan; treat it as unavailable until then.
  if (!config.enabled || config.mode !== "main") return release(sid, UNAVAILABLE, { platform })

  if (req.Type === "Initiation") return startSession(req, deps, config, "")

  const session = await deps.sessions.get(sid)
  if (!session) return startSession(req, deps, config, "Session expired.\n")

  const input = req.Message.trim()
  switch (session.step) {
    case "MAIN": return handleMain(input, req, deps, config, session)
    case "SELECT_NETWORK": return handleSelectNetwork(input, req, deps, config, session)
    case "SELECT_BUNDLE": return handleSelectBundle(input, req, deps, config, session)
    case "ENTER_RECIPIENT": return handleEnterRecipient(input, req, deps, config, session)
    case "CONFIRM": return handleConfirm(input, req, deps, session)
    default: return startSession(req, deps, config, "")
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────
const cs = (step: string) => step // ClientState mirrors the step name (safety net if Redis blips)

function menuFor(config: HubtelUssdConfig, dataBlocked: boolean) {
  return resolveMainMenu(config.visibility as Record<MainMenuKey, boolean>, dataBlocked)
}

async function startSession(req: HubtelRequest, deps: RouterDeps, config: HubtelUssdConfig, prefix: string): Promise<HubtelReply> {
  const dataBlocked = await deps.isDataBlocked(req.Mobile)
  const resolved = menuFor(config, dataBlocked)
  if (resolved.length === 0) {
    await deps.sessions.del(req.SessionId)
    return release(req.SessionId, "No services available right now. Please try again later.", { platform: req.Platform })
  }
  await deps.sessions.set(req.SessionId, { step: "MAIN", dialingPhone: toE164(req.Mobile), platform: req.Platform, dataBlocked })
  return respond(req.SessionId, prefix + mainMenuText(resolved), { label: "Main menu", clientState: cs("MAIN"), platform: req.Platform })
}

function mainReply(req: HubtelRequest, config: HubtelUssdConfig, session: HubtelSession): HubtelReply {
  return respond(req.SessionId, mainMenuText(menuFor(config, session.dataBlocked === true)), {
    label: "Main menu", clientState: cs("MAIN"), platform: req.Platform,
  })
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
async function handleMain(input: string, req: HubtelRequest, deps: RouterDeps, config: HubtelUssdConfig, session: HubtelSession): Promise<HubtelReply> {
  if (input === "0") {
    await deps.sessions.del(req.SessionId)
    return release(req.SessionId, "Thank you for using Datagod.", { platform: req.Platform })
  }
  const key = keyForDigit(menuFor(config, session.dataBlocked === true), input)
  if (key === "data") {
    await deps.sessions.set(req.SessionId, { ...session, step: "SELECT_NETWORK" })
    return respond(req.SessionId, networkMenuText(), { label: "Select network", clientState: cs("SELECT_NETWORK"), platform: req.Platform })
  }
  return mainReply(req, config, session)
}

// ── SELECT_NETWORK ────────────────────────────────────────────────────────────
async function handleSelectNetwork(input: string, req: HubtelRequest, deps: RouterDeps, config: HubtelUssdConfig, session: HubtelSession): Promise<HubtelReply> {
  if (input === "0") {
    await deps.sessions.set(req.SessionId, { ...session, step: "MAIN" })
    return mainReply(req, config, session)
  }
  const net = HUBTEL_NETWORKS.find(n => n.digit === input)
  if (!net) return respond(req.SessionId, networkMenuText(), { label: "Select network", clientState: cs("SELECT_NETWORK"), platform: req.Platform })

  const caller = await deps.resolveCaller(session.dialingPhone)
  const { bundles, total } = await deps.fetchBundles(net.dbName, 0, caller.effectivePriceTier, caller.subAgentParentShopId)
  if (bundles.length === 0) {
    return respond(req.SessionId, `No ${net.label} packages available.\n` + networkMenuText(), { label: "Select network", clientState: cs("SELECT_NETWORK"), platform: req.Platform })
  }
  await deps.sessions.set(req.SessionId, {
    ...session, step: "SELECT_BUNDLE", network: net.dbName, bundlePage: 0,
    effectivePriceTier: caller.effectivePriceTier, subAgentParentShopId: caller.subAgentParentShopId, userId: caller.userId,
  })
  return respond(req.SessionId, bundleMenuText(bundles, 0, total, deps.pageSize), { label: "Select package", clientState: cs("SELECT_BUNDLE"), platform: req.Platform })
}

// ── SELECT_BUNDLE ─────────────────────────────────────────────────────────────
async function handleSelectBundle(input: string, req: HubtelRequest, deps: RouterDeps, config: HubtelUssdConfig, session: HubtelSession): Promise<HubtelReply> {
  if (input === "0") {
    await deps.sessions.set(req.SessionId, { ...session, step: "SELECT_NETWORK" })
    return respond(req.SessionId, networkMenuText(), { label: "Select network", clientState: cs("SELECT_NETWORK"), platform: req.Platform })
  }
  const page = session.bundlePage ?? 0
  const offset = page * deps.pageSize
  // Re-fetch the current page: trusting a cached page goes stale when pages advance.
  const { bundles, total } = await deps.fetchBundles(session.network!, page, session.effectivePriceTier ?? "regular", session.subAgentParentShopId)
  const chosen = parseInt(input, 10)

  if (chosen === offset + bundles.length + 1 && offset + bundles.length < total) {
    const next = page + 1
    const nextPage = await deps.fetchBundles(session.network!, next, session.effectivePriceTier ?? "regular", session.subAgentParentShopId)
    await deps.sessions.set(req.SessionId, { ...session, bundlePage: next })
    return respond(req.SessionId, bundleMenuText(nextPage.bundles, next, nextPage.total, deps.pageSize), { label: "Select package", clientState: cs("SELECT_BUNDLE"), platform: req.Platform })
  }

  const selected = Number.isInteger(chosen) ? bundles[chosen - offset - 1] : undefined
  if (!selected) {
    return respond(req.SessionId, bundleMenuText(bundles, page, total, deps.pageSize), { label: "Select package", clientState: cs("SELECT_BUNDLE"), platform: req.Platform })
  }
  await deps.sessions.set(req.SessionId, {
    ...session, step: "ENTER_RECIPIENT", bundleId: selected.id, bundleSize: selected.size, bundlePrice: selected.price,
  })
  return respond(req.SessionId, recipientPromptText(), { label: "Recipient number", fieldType: "phone", clientState: cs("ENTER_RECIPIENT"), platform: req.Platform })
}

// ── ENTER_RECIPIENT ───────────────────────────────────────────────────────────
async function handleEnterRecipient(input: string, req: HubtelRequest, deps: RouterDeps, config: HubtelUssdConfig, session: HubtelSession): Promise<HubtelReply> {
  if (input === "0") {
    const page = session.bundlePage ?? 0
    const { bundles, total } = await deps.fetchBundles(session.network!, page, session.effectivePriceTier ?? "regular", session.subAgentParentShopId)
    await deps.sessions.set(req.SessionId, { ...session, step: "SELECT_BUNDLE" })
    return respond(req.SessionId, bundleMenuText(bundles, page, total, deps.pageSize), { label: "Select package", clientState: cs("SELECT_BUNDLE"), platform: req.Platform })
  }
  const local = toLocalPhone(input)
  const reprompt = (msg: string) =>
    respond(req.SessionId, `${msg}\n${recipientPromptText()}`, { label: "Recipient number", fieldType: "phone", clientState: cs("ENTER_RECIPIENT"), platform: req.Platform })

  if (!/^0[0-9]{9}$/.test(local)) return reprompt("Invalid number. Enter a valid Ghana phone number.")

  const prefix = await deps.getPrefixConfig()
  if (prefix.enabled && session.network) {
    const check = validateNetworkPrefix(session.network, local, prefix.map)
    if (!check.ok) return reprompt(check.message ?? "Number does not match the selected network.")
  }

  await deps.sessions.set(req.SessionId, { ...session, step: "CONFIRM", recipientPhone: local })
  const net = HUBTEL_NETWORKS.find(n => n.dbName === session.network)
  return respond(
    req.SessionId,
    confirmMenuText(net?.label ?? session.network!, session.bundleSize!, session.bundlePrice!, local, toLocalPhone(session.dialingPhone)),
    { label: "Confirm order", clientState: cs("CONFIRM"), platform: req.Platform }
  )
}

// ── CONFIRM → order + AddToCart ───────────────────────────────────────────────
async function handleConfirm(input: string, req: HubtelRequest, deps: RouterDeps, session: HubtelSession): Promise<HubtelReply> {
  const sid = req.SessionId
  const platform: HubtelPlatform = req.Platform

  if (input === "2") {
    await deps.sessions.del(sid)
    return release(sid, "Order cancelled.", { platform })
  }
  if (input !== "1") {
    const net = HUBTEL_NETWORKS.find(n => n.dbName === session.network)
    return respond(
      sid,
      confirmMenuText(net?.label ?? session.network!, session.bundleSize!, session.bundlePrice!, session.recipientPhone!, toLocalPhone(session.dialingPhone)),
      { label: "Confirm order", clientState: cs("CONFIRM"), platform }
    )
  }

  const { supabase } = deps
  const { data: pkg } = await supabase.from("packages").select("price, dealer_price, is_available").eq("id", session.bundleId!).single()
  if (!pkg || !pkg.is_available) {
    await deps.sessions.del(sid)
    return release(sid, "Package no longer available. Please try again.", { platform })
  }

  const tier = session.effectivePriceTier ?? "regular"
  let catalogRow: { parent_price: number | string; wholesale_margin: number | string } | null = null
  if (tier === "sub_agent" && session.subAgentParentShopId) {
    const { data } = await supabase.from("sub_agent_catalog").select("parent_price, wholesale_margin")
      .eq("shop_id", session.subAgentParentShopId).eq("package_id", session.bundleId!).single()
    catalogRow = data
  }
  const { price, parentProfit } = priceForTier(pkg, tier, catalogRow)

  if (Math.abs(price - session.bundlePrice!) > 0.01) {
    await deps.sessions.del(sid)
    return release(sid, `Price changed to GHS ${price.toFixed(2)}. Please restart your order.`, { platform })
  }

  const { data: order, error: orderError } = await supabase
    .from("ussd_orders")
    .insert([{
      dialing_phone: session.dialingPhone,
      recipient_phone: session.recipientPhone,
      network: session.network,
      // Column is required by the table; the value is unused on the Hubtel channel (payment is Hubtel's).
      paystack_provider: paystackProviderFromPhone(session.dialingPhone) ?? "mtn",
      package_id: session.bundleId,
      package_size: session.bundleSize,
      amount: price, // our price only: the customer pays Hubtel's charge on top, at Hubtel
      price_tier: tier,
      parent_shop_id: session.subAgentParentShopId ?? null,
      parent_profit_amount: parentProfit,
      shop_owner_id: session.userId ?? null,
      order_status: "pending",
      payment_status: "pending",
    }])
    .select("id")
    .single()

  if (orderError || !order) {
    console.error("[HUBTEL-CONFIRM] Failed to create order:", orderError)
    return release(sid, "Error creating order. Please try again.", { platform })
  }

  const { error: txError } = await supabase.from("hubtel_transactions").insert({
    session_id: sid,
    platform,
    order_table: "ussd_orders",
    order_id: order.id,
    mobile: session.dialingPhone,
    expected_amount: price,
  })
  if (txError) {
    console.error("[HUBTEL-CONFIRM] hubtel_transactions insert failed:", txError)
    await supabase.from("ussd_orders")
      .update({ order_status: "failed", payment_status: "failed", updated_at: new Date().toISOString() })
      .eq("id", order.id)
    return release(sid, "Error creating order. Please try again.", { platform })
  }

  await deps.sessions.del(sid)
  const net = HUBTEL_NETWORKS.find(n => n.dbName === session.network)
  return addToCart(sid, {
    itemName: `${session.bundleSize!.match(/^\d+(\.\d+)?$/) ? session.bundleSize + "GB" : session.bundleSize} ${net?.label ?? session.network} Data`,
    price,
    message: "Request submitted. Approve the payment prompt on your phone to complete your order.",
    platform,
  })
}
