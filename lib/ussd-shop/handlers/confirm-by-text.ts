// Text-to-buy, shop line: confirm a shop data order from a text message. A composition of the same primitives the live
// shop USSD confirm (./bundles.ts handleConfirm) and the Hubtel shop flow use: verifyBundlePrice for the price and the
// profit split, createShopBundleOrder for the row, startUssdCharge for the charge. Deliberately imports nothing from
// ./bundles.ts, so the live shop menus are untouched.
//
// What differs from the USSD confirm, all as for the sms channel of the main handler (lib/ussd/handlers/bundles.ts):
// MoMo only and the sender pays (no wallet), the sms_order charge surface, no 3 second wait (a text has no session to
// close first), no OTP redial SMS (the text-to-buy notifier owns every customer message), and the order id and the
// amount written on the row are returned, because the quote the customer is sent must be that amount.
//
// No orderId in the result means nothing was written and nothing will be charged. Every collaborator that is bound to a
// database client at import is injected through ConfirmShopDeps (loaded lazily by defaultDeps), so this is unit-testable.
import { after } from "next/server"
import type { SupabaseClient } from "@supabase/supabase-js"
import { isUssdHubtelPayer, startUssdCharge, ussdOrderAmount, type UssdPrice } from "@/lib/ussd/gateway-charge"
import type { SurfaceKey } from "@/lib/payment-gateway/config"
import type { BundleOrderInput } from "@/lib/shop-commerce/orders"

export interface ConfirmShopInput {
  shopCodeId: string
  shopId: string
  parentShopId: string | null
  paystackProvider: "mtn" | "vod" | "tgo"
  bundleId: string
  /** The recipient, local 0XXXXXXXXX. */
  recipientLocal: string
  /** The texting number, local 0XXXXXXXXX. It pays. */
  senderLocal: string
  /** The inbound message id. Opaque; not logged and not sent to the gateway. */
  messageId: string
}

export interface ConfirmShopResult {
  orderId?: string
  amountGhs?: number
}

export interface ConfirmShopDeps {
  /** The shop behind a shop code id as it is NOW (the id is mapped to its code, then resolveShopCode). */
  resolveShopCode(shopCodeId: string): Promise<{ status: string; shopId: string; parentShopId: string | null } | null>
  /** The data whitelist gate (ussd_data_whitelist_enabled + has_completed_purchase): true = refuse this sender. */
  dataBlocked(senderLocal: string): Promise<boolean>
  /** The network-prefix check (admin-toggleable): false = the number is on another network. */
  prefixAllowed(network: string, recipientLocal: string): Promise<boolean>
  /** The MTN verification hard block: true = refuse this recipient. */
  recipientBlocked(network: string, recipientLocal: string): Promise<boolean>
  /** The package the bundle id names: the order row needs its network and size. */
  loadBundle(bundleId: string): Promise<{ network: string; size: string } | null>
  verifyBundlePrice(shopId: string, bundleId: string, parentShopId?: string): Promise<{ verifiedPrice: number; profitAmount: number; parentProfitAmount: number } | null>
  /** The Paystack fee, in percent. */
  paystackFeePercent(): Promise<number>
  /** The gateway fee function: the amount to write on the order for this surface and payer. */
  orderAmount(surface: SurfaceKey, verifiedPayer: boolean, price: UssdPrice): Promise<number>
  orderContext(shopId: string, senderLocal: string): Promise<{ shopName: string | null; customerEmail: string | null; shopOwnerEmail: string | null }>
  createShopBundleOrder(input: BundleOrderInput): Promise<{ orderId: string } | { error: string }>
  startUssdCharge: typeof startUssdCharge
  /** The guarded move of a still-unpaid shop order from `from` to `to` (startUssdCharge's `reprice`). */
  reprice(orderId: string, from: number, to: number): () => Promise<boolean>
  /** Runs work after the response (next/server `after`). */
  schedule(fn: () => Promise<void>): void
  store: {
    recordCharge(orderId: string, o: { amount: number; email: string }): Promise<void>
    markOtpRequired(orderId: string): Promise<void>
    markFailed(orderId: string): Promise<void>
  }
}

const SURFACE: SurfaceKey = "sms_order"

const usable = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n)

export async function confirmShopBundleByText(input: ConfirmShopInput, deps?: ConfirmShopDeps): Promise<ConfirmShopResult> {
  const d = deps ?? (await defaultDeps())
  const { shopCodeId, shopId, paystackProvider, bundleId, recipientLocal, senderLocal } = input
  const parentShopId = input.parentShopId ?? null
  try {
    // The data whitelist (the shop USSD applies it when a network is chosen): an unreadable gate refuses.
    if (await d.dataBlocked(senderLocal)) return {}

    const bundle = await d.loadBundle(bundleId)
    if (!bundle) return {}
    const { network, size } = bundle

    // The checks the shop USSD makes when the recipient is entered.
    if (!(await d.prefixAllowed(network, recipientLocal))) return {}
    if (await d.recipientBlocked(network, recipientLocal)) return {}

    // Price and profit split straight from the database (sub-agent branch included). Not offered: refuse.
    const verified = await d.verifyBundlePrice(shopId, bundleId, parentShopId ?? undefined)
    if (!verified) return {}
    const { verifiedPrice, profitAmount, parentProfitAmount } = verified
    // Fail closed: a price or profit snapshot that is not a usable number never reaches an order.
    if (!usable(verifiedPrice) || verifiedPrice <= 0 || !usable(profitAmount) || !usable(parentProfitAmount)) {
      console.error("[TTB-SHOP-CONFIRM] Unusable verified price/profit snapshot; refusing order")
      return {}
    }

    const feePercent = (await d.paystackFeePercent()) / 100
    const fee = Math.round(verifiedPrice * feePercent * 100) / 100
    const price: UssdPrice = { hubtel: verifiedPrice, paystack: verifiedPrice + fee }
    // The texting number is the owner and the payer.
    const verifiedPayer = isUssdHubtelPayer({ chargePhone: senderLocal, ownerPhone: senderLocal, provider: paystackProvider })
    const chargeAmount = await d.orderAmount(SURFACE, verifiedPayer, price)
    if (!usable(chargeAmount) || chargeAmount <= 0) return {}

    const ctx = await d.orderContext(shopId, senderLocal)

    // Time-of-check: the shop must still be open right before the order is written (a text can be minutes old),
    // and must still be the shop and parent the offer was priced for.
    const shop = await d.resolveShopCode(shopCodeId)
    if (!shop || shop.status !== "active" || shop.shopId !== shopId || (shop.parentShopId ?? null) !== parentShopId) return {}

    const created = await d.createShopBundleOrder({
      shopCodeId, shopId, parentShopId, dialingPhone: senderLocal, recipientPhone: recipientLocal, network,
      paystackProvider, bundleId, bundleSize: size, verifiedPrice, profitAmount, parentProfitAmount, chargeAmount,
      shopName: ctx.shopName, customerEmail: ctx.customerEmail, shopOwnerEmail: ctx.shopOwnerEmail, channel: "sms_shop",
    })
    if ("error" in created) {
      console.error("[TTB-SHOP-CONFIRM] Failed to create order:", created.error)
      return {}
    }

    const orderId = created.orderId
    const email = ctx.customerEmail ?? `${senderLocal.replace(/\D/g, "")}@ussd.datagod.com`

    try {
      d.schedule(() => charge(d, { orderId, email, input, network, size, verifiedPayer, price, chargeAmount }))
    } catch (err) {
      // Nothing can be charged (no request scope to run in): close the order rather than leave it pending, and say so.
      console.error("[TTB-SHOP-CONFIRM] Could not schedule the charge:", err instanceof Error ? err.message : "unknown error")
      await d.store.markFailed(orderId).catch(() => {})
      return {}
    }

    return { orderId, amountGhs: chargeAmount }
  } catch (err) {
    // Any failure before the order exists means nothing was written.
    console.error("[TTB-SHOP-CONFIRM] Refused:", err instanceof Error ? err.message : "unknown error")
    return {}
  }
}

async function charge(
  d: ConfirmShopDeps,
  o: { orderId: string; email: string; input: ConfirmShopInput; network: string; size: string; verifiedPayer: boolean; price: UssdPrice; chargeAmount: number },
): Promise<void> {
  const { orderId, email, input, network, size, verifiedPayer, price, chargeAmount } = o
  // No wait: a text has no session to close first.
  try {
    const { status, amount: charged } = await d.startUssdCharge({
      surface: SURFACE,
      verifiedPayer,
      price,
      written: chargeAmount,
      params: {
        email,
        phone: input.senderLocal,
        provider: input.paystackProvider,
        reference: orderId,
        metadata: {
          source: "sms_shop",
          ussd_shop_order_id: orderId,
          recipient_phone: input.recipientLocal,
          network,
          package_size: size,
          shop_id: input.shopId,
        },
      },
      reprice: d.reprice(orderId, chargeAmount, price.paystack),
    })
    try {
      await d.store.recordCharge(orderId, { amount: charged, email })
    } catch (e) {
      console.warn("[TTB-SHOP-CONFIRM] recording the charge failed (non-fatal):", e instanceof Error ? e.message : "unknown error")
    }
    if (status === "send_otp") {
      // Nothing is sent: the text-to-buy notifier owns every customer message for this channel.
      await d.store.markOtpRequired(orderId)
    }
  } catch (err) {
    console.error("[TTB-SHOP-CONFIRM] Charge failed:", err instanceof Error ? err.message : "unknown error")
    try {
      await d.store.markFailed(orderId)
    } catch {
      console.error("[TTB-SHOP-CONFIRM] Could not mark the order failed")
    }
  }
}

/** The real collaborators. Loaded on first use: the modules below build service-role clients when imported. */
async function defaultDeps(): Promise<ConfirmShopDeps> {
  const [{ createClient }, shopCode, pricing, orders, prefix, verification, resolveEmailMod, gateway] = await Promise.all([
    import("@supabase/supabase-js"),
    import("@/lib/shop-commerce/shop-code"),
    import("@/lib/shop-commerce/pricing"),
    import("@/lib/shop-commerce/orders"),
    import("@/lib/network-prefix-config"),
    import("@/lib/mtn-providers/customer-verification"),
    import("@/lib/ussd/resolve-email"),
    import("@/lib/ussd/gateway-charge"),
  ])
  const db: SupabaseClient = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
  const now = () => new Date().toISOString()
  const msisdn = (local: string) => `+233${local.slice(1)}`

  return {
    async resolveShopCode(shopCodeId) {
      const { data } = await db.from("ussd_shop_codes").select("code").eq("id", shopCodeId).maybeSingle()
      if (!data?.code) return null
      const shop = await shopCode.resolveShopCode(data.code as string)
      return shop ? { status: shop.status, shopId: shop.shopId, parentShopId: shop.parentShopId } : null
    },

    async dataBlocked(senderLocal) {
      const [{ data: row, error: rowError }, { data: purchased, error: rpcError }] = await Promise.all([
        db.from("admin_settings").select("value").eq("key", "ussd_data_whitelist_enabled").maybeSingle(),
        db.rpc("has_completed_purchase", { local_phone: senderLocal, msisdn: msisdn(senderLocal) }),
      ])
      // The shop USSD lets an unreadable gate through; a text that places a charge does not.
      if (rowError || rpcError) throw new Error("data whitelist unreadable")
      return (row as { value?: { enabled?: boolean } } | null)?.value?.enabled === true && purchased !== true
    },

    async prefixAllowed(network, recipientLocal) {
      const { validateNetworkPrefix } = await import("@/lib/phone-format")
      const { enabled, map } = await prefix.getPrefixValidationConfig()
      return !enabled || validateNetworkPrefix(network, recipientLocal, map).ok
    },

    recipientBlocked: (network, recipientLocal) => verification.isRecipientBlocked(network, recipientLocal),

    async loadBundle(bundleId) {
      const { data } = await db.from("packages").select("network, size").eq("id", bundleId).maybeSingle()
      const row = data as { network?: string; size?: string } | null
      return row?.network && row?.size ? { network: row.network, size: row.size } : null
    },

    verifyBundlePrice: (shopId, bundleId, parentShopId) => pricing.verifyBundlePrice(shopId, bundleId, parentShopId),

    async paystackFeePercent() {
      const { data } = await db.from("app_settings").select("paystack_fee_percentage").is("key", null).single()
      return (data as { paystack_fee_percentage?: number } | null)?.paystack_fee_percentage ?? 3.0
    },

    orderAmount: ussdOrderAmount,

    async orderContext(shopId, senderLocal) {
      const [customerEmail, owner, shopName] = await Promise.all([
        resolveEmailMod.resolveEmail(senderLocal).catch(() => null),
        db.from("user_shops").select("user_id, users!inner(email)").eq("id", shopId).single().then((r) => r.data),
        shopCode.getCanonicalShopName(shopId).catch(() => null),
      ])
      return { shopName, customerEmail, shopOwnerEmail: (owner as { users?: { email?: string } } | null)?.users?.email ?? null }
    },

    createShopBundleOrder: (i) => orders.createShopBundleOrder(i),
    startUssdCharge,

    reprice: (orderId, from, to) =>
      gateway.guardedReprice(db, "ussd_shop_orders", orderId, { from: { amount: from }, set: { amount: to }, guards: { payment_status: "pending" } }),

    schedule: (fn) => after(fn),

    store: {
      async recordCharge(orderId, { amount, email }) {
        await db.from("payment_attempts").insert({ reference: orderId, amount, email, status: "pending", payment_type: "ussd_shop", order_id: orderId })
        await db.from("ussd_shop_orders").update({ paystack_reference: orderId, updated_at: now() }).eq("id", orderId)
      },
      async markOtpRequired(orderId) {
        await db.from("ussd_shop_orders").update({ payment_status: "otp_required", updated_at: now() }).eq("id", orderId)
      },
      async markFailed(orderId) {
        await db.from("ussd_shop_orders").update({ order_status: "failed", payment_status: "failed", updated_at: now() }).eq("id", orderId)
      },
    },
  }
}
