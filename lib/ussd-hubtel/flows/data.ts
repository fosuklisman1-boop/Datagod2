// lib/ussd-hubtel/flows/data.ts
// Main-mode data bundles. Moved from router.ts (Plan 2 Task 1) with identical behaviour.
import { validateNetworkPrefix } from "@/lib/phone-format"
import { paystackProviderFromPhone } from "@/lib/ussd/paystack-provider"
import { priceForTier } from "../catalog"
import { HUBTEL_NETWORKS, networkMenuText, bundleMenuText, recipientPromptText, confirmMenuText } from "../menus"
import { toLocalPhone } from "../protocol"
import { backToMain, finish, goto, replaySubmittedOrder, say, submitOrder, type FlowCtx, type StepTable } from "../flow-kit"
import type { HubtelReply, HubtelSession } from "../types"

const NETWORK = { label: "Select network" }
const PACKAGE = { label: "Select package" }
const RECIPIENT = { label: "Recipient number", fieldType: "phone" as const }
const CONFIRM = { label: "Confirm order" }

function confirmText(s: HubtelSession): string {
  const net = HUBTEL_NETWORKS.find(n => n.dbName === s.network)
  return confirmMenuText(net?.label ?? s.network!, s.bundleSize!, s.bundlePrice!, s.recipientPhone!, toLocalPhone(s.dialingPhone))
}

export async function startData(ctx: FlowCtx): Promise<HubtelReply> {
  return goto(ctx, { step: "SELECT_NETWORK" }, networkMenuText(), NETWORK)
}

async function selectNetwork(ctx: FlowCtx): Promise<HubtelReply> {
  const { input, deps, session } = ctx
  if (input === "0") return backToMain(ctx)
  const net = HUBTEL_NETWORKS.find(n => n.digit === input)
  if (!net) return say(ctx, networkMenuText(), "SELECT_NETWORK", NETWORK)

  const caller = await deps.resolveCaller(session.dialingPhone)
  const { bundles, total } = await deps.fetchBundles(net.dbName, 0, caller.effectivePriceTier, caller.subAgentParentShopId)
  if (bundles.length === 0) return say(ctx, `No ${net.label} packages available.\n` + networkMenuText(), "SELECT_NETWORK", NETWORK)
  return goto(ctx, {
    step: "SELECT_BUNDLE", network: net.dbName, bundlePage: 0,
    effectivePriceTier: caller.effectivePriceTier, subAgentParentShopId: caller.subAgentParentShopId, userId: caller.userId,
  }, bundleMenuText(bundles, 0, total, deps.pageSize), PACKAGE)
}

async function selectBundle(ctx: FlowCtx): Promise<HubtelReply> {
  const { input, deps, session } = ctx
  if (input === "0") return goto(ctx, { step: "SELECT_NETWORK" }, networkMenuText(), NETWORK)
  const page = session.bundlePage ?? 0
  const offset = page * deps.pageSize
  const tier = session.effectivePriceTier ?? "regular"
  // Re-fetch the current page: trusting a cached page goes stale when pages advance.
  const { bundles, total } = await deps.fetchBundles(session.network!, page, tier, session.subAgentParentShopId)
  const chosen = parseInt(input, 10)

  if (chosen === offset + bundles.length + 1 && offset + bundles.length < total) {
    const next = page + 1
    const nextPage = await deps.fetchBundles(session.network!, next, tier, session.subAgentParentShopId)
    return goto(ctx, { step: "SELECT_BUNDLE", bundlePage: next }, bundleMenuText(nextPage.bundles, next, nextPage.total, deps.pageSize), PACKAGE)
  }

  const selected = Number.isInteger(chosen) ? bundles[chosen - offset - 1] : undefined
  if (!selected) return say(ctx, bundleMenuText(bundles, page, total, deps.pageSize), "SELECT_BUNDLE", PACKAGE)
  return goto(ctx, {
    step: "ENTER_RECIPIENT", bundleId: selected.id, bundleSize: selected.size, bundlePrice: selected.price,
  }, recipientPromptText(), RECIPIENT)
}

async function enterRecipient(ctx: FlowCtx): Promise<HubtelReply> {
  const { input, deps, session } = ctx
  if (input === "0") {
    const page = session.bundlePage ?? 0
    const { bundles, total } = await deps.fetchBundles(session.network!, page, session.effectivePriceTier ?? "regular", session.subAgentParentShopId)
    return goto(ctx, { step: "SELECT_BUNDLE" }, bundleMenuText(bundles, page, total, deps.pageSize), PACKAGE)
  }
  const local = toLocalPhone(input)
  const reprompt = (msg: string) => say(ctx, `${msg}\n${recipientPromptText()}`, "ENTER_RECIPIENT", RECIPIENT)

  if (!/^0[0-9]{9}$/.test(local)) return reprompt("Invalid number. Enter a valid Ghana phone number.")

  const prefix = await deps.getPrefixConfig()
  if (prefix.enabled && session.network) {
    const check = validateNetworkPrefix(session.network, local, prefix.map)
    if (!check.ok) return reprompt(check.message ?? "Number does not match the selected network.")
  }
  return goto(ctx, { step: "CONFIRM", recipientPhone: local }, confirmText({ ...session, recipientPhone: local }), CONFIRM)
}

async function confirm(ctx: FlowCtx): Promise<HubtelReply> {
  const { input, deps, req, session } = ctx
  if (input === "2") return finish(ctx, "Order cancelled.")
  if (input !== "1") return say(ctx, confirmText(session), "CONFIRM", CONFIRM)

  const replay = await replaySubmittedOrder(deps, req.SessionId, req.Platform)
  if (replay) return replay

  const { data: pkg } = await deps.supabase.from("packages").select("price, dealer_price, is_available").eq("id", session.bundleId!).single()
  if (!pkg || !pkg.is_available) return finish(ctx, "Package no longer available. Please try again.")

  const tier = session.effectivePriceTier ?? "regular"
  let catalogRow: { parent_price: number | string; wholesale_margin: number | string } | null = null
  if (tier === "sub_agent" && session.subAgentParentShopId) {
    const { data } = await deps.supabase.from("sub_agent_catalog").select("parent_price, wholesale_margin")
      .eq("shop_id", session.subAgentParentShopId).eq("package_id", session.bundleId!).single()
    catalogRow = data
  }
  const { price, parentProfit } = priceForTier(pkg, tier, catalogRow)
  if (Math.abs(price - session.bundlePrice!) > 0.01) {
    return finish(ctx, `Price changed to GHS ${price.toFixed(2)}. Please restart your order.`)
  }

  return submitOrder(ctx, {
    table: "ussd_orders",
    price,
    logTag: "HUBTEL-CONFIRM",
    row: {
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
    },
  })
}

export const DATA_STEPS: StepTable = {
  SELECT_NETWORK: selectNetwork,
  SELECT_BUNDLE: selectBundle,
  ENTER_RECIPIENT: enterRecipient,
  CONFIRM: confirm,
}
