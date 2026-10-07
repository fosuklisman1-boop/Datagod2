// lib/ussd-hubtel/flows/shop-data.ts
// Shop-mode data bundles. Port of lib/ussd-shop/handlers/bundles.ts minus Paystack and OTP: the
// shop's catalog and prices (lib/shop-commerce), CONFIRM ends in AddToCart at the shop price.
import { validateNetworkPrefix } from "@/lib/phone-format"
import { paystackProviderFromPhone } from "@/lib/ussd/paystack-provider"
import {
  bundleMenuText, confirmMenuText, recipientPromptText, shopHeader, shopNetworkLabel, shopNetworkMenuText,
} from "../menus"
import { toLocalPhone } from "../protocol"
import { finish, goto, replaySubmittedOrder, say, submitOrder, type FlowCtx, type StepTable } from "../flow-kit"
import { backToProduct, shopMenuReply } from "./shop"
import type { HubtelReply, HubtelSession } from "../types"

const NETWORK = { label: "Select network" }
const PACKAGE = { label: "Select package" }
const RECIPIENT = { label: "Recipient number", fieldType: "phone" as const }
const CONFIRM = { label: "Confirm order" }

const shopName = (s: HubtelSession) => s.shopName ?? "Shop"
const networksOf = (s: HubtelSession) => s.shopNetworks ?? []

function networkScreen(s: HubtelSession): string {
  return shopNetworkMenuText(shopName(s), networksOf(s))
}

function confirmText(s: HubtelSession): string {
  return `${shopHeader(shopName(s))}\n` + confirmMenuText(
    shopNetworkLabel(s.network!), s.bundleSize!, s.bundlePrice!, s.recipientPhone!, toLocalPhone(s.dialingPhone)
  )
}

/** One page of the shop's bundles. Re-fetched every time: shop prices may change mid-session. */
async function pageOf(ctx: FlowCtx, network: string, page: number) {
  const all = await ctx.deps.shop.bundles(ctx.session.shopId!, network, ctx.session.parentShopId)
  const size = ctx.deps.pageSize
  return { bundles: all.slice(page * size, (page + 1) * size), total: all.length }
}

export async function startShopData(ctx: FlowCtx): Promise<HubtelReply> {
  if (networksOf(ctx.session).length === 0) return shopMenuReply(ctx, "No packages available.\n")
  return goto(ctx, { step: "SHOP_DATA_NETWORK" }, networkScreen(ctx.session), NETWORK)
}

async function selectNetwork(ctx: FlowCtx): Promise<HubtelReply> {
  const { input, deps, session } = ctx
  if (input === "0") return backToProduct(ctx) // D5: never back to code entry
  const network = /^\d+$/.test(input) ? networksOf(session)[Number(input) - 1] : undefined
  if (!network) return say(ctx, networkScreen(session), "SHOP_DATA_NETWORK", NETWORK)
  const { bundles, total } = await pageOf(ctx, network, 0)
  if (bundles.length === 0) {
    return say(ctx, `No ${shopNetworkLabel(network)} packages available.\n` + networkScreen(session), "SHOP_DATA_NETWORK", NETWORK)
  }
  return goto(ctx, { step: "SHOP_DATA_BUNDLE", network, bundlePage: 0 }, bundleMenuText(bundles, 0, total, deps.pageSize), PACKAGE)
}

async function selectBundle(ctx: FlowCtx): Promise<HubtelReply> {
  const { input, deps, session } = ctx
  if (input === "0") return goto(ctx, { step: "SHOP_DATA_NETWORK" }, networkScreen(session), NETWORK)
  const page = session.bundlePage ?? 0
  const offset = page * deps.pageSize
  const { bundles, total } = await pageOf(ctx, session.network!, page)
  const chosen = /^\d+$/.test(input) ? Number(input) : NaN

  if (chosen === offset + bundles.length + 1 && offset + bundles.length < total) {
    const next = page + 1
    const nextPage = await pageOf(ctx, session.network!, next)
    return goto(ctx, { step: "SHOP_DATA_BUNDLE", bundlePage: next }, bundleMenuText(nextPage.bundles, next, nextPage.total, deps.pageSize), PACKAGE)
  }

  const selected = Number.isInteger(chosen) ? bundles[chosen - offset - 1] : undefined
  if (!selected) return say(ctx, bundleMenuText(bundles, page, total, deps.pageSize), "SHOP_DATA_BUNDLE", PACKAGE)
  return goto(ctx, {
    step: "SHOP_DATA_RECIPIENT", bundleId: selected.id, bundleSize: selected.size, bundlePrice: selected.price,
  }, recipientPromptText(), RECIPIENT)
}

async function enterRecipient(ctx: FlowCtx): Promise<HubtelReply> {
  const { input, deps, session } = ctx
  if (input === "0") {
    const page = session.bundlePage ?? 0
    const { bundles, total } = await pageOf(ctx, session.network!, page)
    return goto(ctx, { step: "SHOP_DATA_BUNDLE" }, bundleMenuText(bundles, page, total, deps.pageSize), PACKAGE)
  }
  const local = toLocalPhone(input.replace(/\s+/g, ""))
  const reprompt = (msg: string) => say(ctx, `${msg}\n${recipientPromptText()}`, "SHOP_DATA_RECIPIENT", RECIPIENT)
  if (!/^0[0-9]{9}$/.test(local)) return reprompt("Invalid number. Enter a valid Ghana phone number.")

  // Network <-> prefix hard block (admin-toggleable), as the Uzo shop.
  const prefix = await deps.getPrefixConfig()
  if (prefix.enabled && session.network) {
    const check = validateNetworkPrefix(session.network, local, prefix.map)
    if (!check.ok) return reprompt(check.message ?? "Number does not match the selected network.")
  }
  return goto(ctx, { step: "SHOP_DATA_CONFIRM", recipientPhone: local }, confirmText({ ...session, recipientPhone: local }), CONFIRM)
}

async function confirm(ctx: FlowCtx): Promise<HubtelReply> {
  const { input, deps, req, session } = ctx
  if (input === "2") return finish(ctx, "Order cancelled.")
  if (input !== "1") return say(ctx, confirmText(session), "SHOP_DATA_CONFIRM", CONFIRM)

  const replay = await replaySubmittedOrder(deps, req.SessionId, req.Platform)
  if (replay) return replay

  // Re-verify the shop price and the profit split straight from the DB (stale-session guard).
  const verified = await deps.shop.verifyBundlePrice(session.shopId!, session.bundleId!, session.parentShopId)
  if (!verified) return finish(ctx, "Package no longer available. Please try again.")
  const { verifiedPrice, profitAmount, parentProfitAmount } = verified
  // Fail closed: a price or profit snapshot that is not a usable number never reaches the order.
  const sane = Number.isFinite(verifiedPrice) && verifiedPrice > 0
    && Number.isFinite(profitAmount) && profitAmount >= 0
    && Number.isFinite(parentProfitAmount) && parentProfitAmount >= 0
  if (!sane) {
    console.error("[HUBTEL-SHOP-DATA] Unusable verified price/profit snapshot; refusing order. session:", req.SessionId)
    return finish(ctx, "Package no longer available. Please try again.")
  }
  if (!(Math.abs(verifiedPrice - session.bundlePrice!) <= 0.01)) {
    return finish(ctx, `Price changed to GHS ${verifiedPrice.toFixed(2)}. Please restart your order.`)
  }
  const info = await deps.shop.orderContext(session.shopId!, session.dialingPhone)

  return submitOrder(ctx, {
    table: "ussd_shop_orders",
    price: verifiedPrice,
    logTag: "HUBTEL-SHOP-DATA",
    // Same columns as lib/shop-commerce/orders.ts createShopBundleOrder (the Uzo shop insert).
    row: {
      shop_code_id: session.shopCodeId,
      shop_id: session.shopId,
      dialing_phone: session.dialingPhone,
      recipient_phone: session.recipientPhone,
      network: session.network,
      // NOT NULL column; unused on this channel (payment is Hubtel's).
      paystack_provider: paystackProviderFromPhone(session.dialingPhone) ?? "mtn",
      package_id: session.bundleId,
      package_size: session.bundleSize,
      amount: verifiedPrice, // the shop price only: Hubtel adds its own charge on top
      shop_price: verifiedPrice,
      profit_amount: profitAmount, // credited to shop_id after payment
      parent_shop_id: session.parentShopId ?? null,
      parent_profit_amount: parentProfitAmount, // credited to parent_shop_id after payment
      shop_name: info.shopName,
      customer_email: info.customerEmail,
      shop_owner_email: info.shopOwnerEmail,
      order_status: "pending",
      payment_status: "pending",
      channel: "ussd_shop",
    },
  })
}

export const SHOP_DATA_STEPS: StepTable = {
  SHOP_DATA_NETWORK: selectNetwork,
  SHOP_DATA_BUNDLE: selectBundle,
  SHOP_DATA_RECIPIENT: enterRecipient,
  SHOP_DATA_CONFIRM: confirm,
}
