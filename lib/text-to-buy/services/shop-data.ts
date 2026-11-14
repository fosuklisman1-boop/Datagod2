import type { SupabaseClient } from "@supabase/supabase-js"
import type { ShopBundleOption } from "@/lib/ussd-shop/types"
import type { confirmShopBundleByText } from "@/lib/ussd-shop/handlers/confirm-by-text"
import { normalizeGhanaPhone } from "@/lib/phone-format"
import { paystackProviderFromPhone } from "@/lib/ussd/paystack-provider"
import { parseSizeMb, sizeLabel } from "../catalogue"
import { fitOneSegment, notUnderstoodReply, shopOffReply, shopQuoteReply, shopSizeUnavailableReply, wrongNumberReply, paidNotDeliveredReply, deliveredGiftReply, unpaidReply } from "../replies"
import type { ShopRef } from "../shop/resolve"
import { orderRowFor, type LastOrder, type Pending } from "../store"
import type { NetworkHint } from "../types"
import { classifyOrder } from "./classify"
import { orderStatusOf } from "../inbound-steps"
import type { Refusal, ServiceAdapter, ServiceOffer } from "./types"

/**
 * The data-bundle service of the shop line: the same texts as the main data adapter, priced from ONE shop's own packages and
 * placed through the shop confirm (confirmShopBundleByText), so the order lands in ussd_shop_orders with the shop's profit split.
 * The shop is resolved by the lane before this adapter is built; the sender never chooses a price.
 */
type Product = "MTN" | "Telecel" | "AT-iShare" | "AT-BigTime"
type Carrier = "MTN" | "TELECEL" | "AT"
type Provider = "mtn" | "vod" | "tgo"

export type ShopDataOffer = ServiceOffer & {
  service: "data"
  shop: ShopRef
  bundleId: string
  product: Product
  networkLabel: "MTN" | "Telecel" | "AT"
  /** What the shop sells it for, re-verified from the database just now. The charged amount is fixed when the order row is written. */
  price: number
}

export type ShopDataDeps = {
  /** The shop's live bundles on one product (lib/shop-commerce/pricing fetchShopBundles). Throws when they cannot be read. */
  shopPrices?: (shop: ShopRef, product: Product) => Promise<ShopBundleOption[]>
  /** The shop's verified price for one bundle (verifyBundlePrice); null = the shop does not offer it. */
  verifyPrice?: (shop: ShopRef, bundleId: string) => Promise<{ verifiedPrice: number } | null>
  /** The carrier a number is on (the admin prefix map); null when unknown. */
  carrierOf?: (recipientLocal: string) => Promise<Carrier | null>
  confirmShop?: typeof confirmShopBundleByText
  /** The admin's global data on/off switch (the same read the main catalogue makes). Throws when unreadable: the adapter fails closed. */
  dataVisible?: (db: SupabaseClient) => Promise<boolean>
}

const PRODUCT_LABEL: Record<Product, ShopDataOffer["networkLabel"]> = { MTN: "MTN", Telecel: "Telecel", "AT-iShare": "AT", "AT-BigTime": "AT" }
const PRODUCT_PROVIDER: Record<Product, Provider> = { MTN: "mtn", Telecel: "vod", "AT-iShare": "tgo", "AT-BigTime": "tgo" }
const CARRIER_PRODUCTS: Record<Carrier, Product[]> = { MTN: ["MTN"], TELECEL: ["Telecel"], AT: ["AT-iShare", "AT-BigTime"] }
const CARRIER_LABEL: Record<Carrier, ShopDataOffer["networkLabel"]> = { MTN: "MTN", TELECEL: "Telecel", AT: "AT" }
const HINT_CARRIER: Record<NetworkHint, Carrier> = { MTN: "MTN", Telecel: "TELECEL", AT: "AT", "AT-iShare": "AT", "AT-BigTime": "AT" }
const PRODUCT_NAME: Record<Product, string> = { MTN: "MTN", Telecel: "Telecel", "AT-iShare": "AT iShare", "AT-BigTime": "AT BigTime" }

/** The real collaborators, loaded on first use: pricing builds a service-role client at import. */
const defaultShopPrices: NonNullable<ShopDataDeps["shopPrices"]> = async (shop, product) => {
  const { fetchShopBundles } = await import("@/lib/shop-commerce/pricing")
  return fetchShopBundles(shop.shopId, product, shop.parentShopId ?? undefined)
}
const defaultVerifyPrice: NonNullable<ShopDataDeps["verifyPrice"]> = async (shop, bundleId) => {
  const { verifyBundlePrice } = await import("@/lib/shop-commerce/pricing")
  return verifyBundlePrice(shop.shopId, bundleId, shop.parentShopId ?? undefined)
}
const defaultCarrierOf: NonNullable<ShopDataDeps["carrierOf"]> = async (recipientLocal) => {
  const [{ detectNetworkWithMap }, { getPrefixValidationConfig }] = await Promise.all([import("@/lib/phone-format"), import("@/lib/network-prefix-config")])
  const { map } = await getPrefixValidationConfig()
  const carrier = detectNetworkWithMap(recipientLocal, map)
  return carrier === "UNKNOWN" ? null : carrier
}

const defaultDataVisible: NonNullable<ShopDataDeps["dataVisible"]> = async (db) => {
  const { getUssdServiceVisibility } = await import("@/lib/ussd-service-visibility")
  return (await getUssdServiceVisibility(db)).data
}

/** `shop` is null only for the read-only registry (status, notices): resolve then fails closed. place and quote use the offer's own shop. */
export function shopDataAdapter(deps: ShopDataDeps, shop: ShopRef | null): ServiceAdapter<ShopDataOffer> {
  const shopPrices = deps.shopPrices ?? defaultShopPrices
  const verifyPrice = deps.verifyPrice ?? defaultVerifyPrice
  const carrierOf = deps.carrierOf ?? defaultCarrierOf
  const dataVisible = deps.dataVisible ?? defaultDataVisible

  return {
    service: "data",
    orderTable: "ussd_shop_orders",
    // The lane gates the whole shop line with lineEnabled; there is no separate text switch for shop data.
    textEnabled: () => true,

    async resolve(db, senderLocal, read) {
      const refuse = (refusal: Refusal) => ({ ok: false as const, refusal })
      if (read.service !== "data" || !shop) return refuse({ outcome: "unavailable", reply: shop ? notUnderstoodReply() : shopOffReply("This shop"), remember: false })

      // The admin's global data switch, as on the main line and the shop USSD. Off or unreadable: nothing is sold.
      let visible = false
      try {
        visible = await dataVisible(db)
      } catch {
        visible = false
      }
      if (!visible) return refuse({ outcome: "unavailable", reply: shopOffReply(shop.name), remember: false })

      const recipientLocal = read.recipient === null ? senderLocal : normalizeGhanaPhone(read.recipient)
      if (!recipientLocal) return refuse({ outcome: "asked", reply: wrongNumberReply(), remember: true })
      const gift = recipientLocal !== senderLocal

      const carrier = await carrierOf(recipientLocal)
      if (!carrier) return refuse({ outcome: "asked", reply: wrongNumberReply(), remember: true })
      if (read.networkHint && HINT_CARRIER[read.networkHint] !== carrier) {
        return refuse(
          read.recipient === null
            ? { outcome: "asked", reply: fitOneSegment([`Which ${CARRIER_LABEL[HINT_CARRIER[read.networkHint]]} number should receive it?`]), remember: true }
            : { outcome: "asked", reply: wrongNumberReply(), remember: true },
        )
      }

      const products = read.networkHint === "AT-iShare" || read.networkHint === "AT-BigTime" ? [read.networkHint as Product] : CARRIER_PRODUCTS[carrier]
      const networkLabel = CARRIER_LABEL[carrier]

      // The shop's own packages, per product. Two of one size on one product: the cheaper.
      let matches: { product: Product; bundle: ShopBundleOption }[]
      try {
        const per = await Promise.all(products.map(async (product) => ({ product, bundles: await shopPrices(shop, product) })))
        matches = per.flatMap(({ product, bundles }) => {
          const hit = bundles
            .filter((b) => parseSizeMb(b.size) === read.sizeMb && Number.isFinite(Number(b.price)) && Number(b.price) > 0)
            .sort((a, b) => Number(a.price) - Number(b.price) || (a.id < b.id ? -1 : 1))[0]
          return hit ? [{ product, bundle: hit }] : []
        })
      } catch {
        return refuse({ outcome: "unavailable", reply: shopOffReply(shop.name), remember: false })
      }

      if (matches.length === 0) return refuse({ outcome: "unavailable", reply: shopSizeUnavailableReply(shop.name, networkLabel), remember: false })
      if (matches.length > 1) {
        const labels = matches.map((m, k) => `${k + 1}) ${PRODUCT_NAME[m.product]} ${sizeLabel(m.bundle.size)}`)
        const pending: Pending = {
          type: "choices",
          options: matches.map((m, k) => ({ label: labels[k], read: { ...read, networkHint: m.product, bare: false } })),
        }
        return refuse({ outcome: "asked", reply: fitOneSegment(["Which one?", ...labels]), pending, remember: true })
      }

      const { product, bundle } = matches[0]
      // The price the shop would charge right now, from the database. Not offered (or unreadable): the shop does not have it.
      let verified: { verifiedPrice: number } | null
      try {
        verified = await verifyPrice(shop, bundle.id)
      } catch {
        return refuse({ outcome: "unavailable", reply: shopOffReply(shop.name), remember: false })
      }
      if (!verified || !Number.isFinite(verified.verifiedPrice) || verified.verifiedPrice <= 0) {
        return refuse({ outcome: "unavailable", reply: shopSizeUnavailableReply(shop.name, networkLabel), remember: false })
      }

      const lastOrder: LastOrder = { sizeMb: parseSizeMb(bundle.size) ?? read.sizeMb, network: product, recipient: recipientLocal }
      const offer: ShopDataOffer = {
        service: "data", shop, bundleId: bundle.id, product, networkLabel: PRODUCT_LABEL[product], size: bundle.size, recipientLocal, gift,
        previewGhs: verified.verifiedPrice, price: verified.verifiedPrice,
        // The payer's provider (the texting number), as on the main line.
        paystackProvider: paystackProviderFromPhone(senderLocal) ?? PRODUCT_PROVIDER[product], lastOrder,
      }
      return { ok: true, offer }
    },

    async place(offer, messageId, senderLocal) {
      const confirm = deps.confirmShop ?? (await import("@/lib/ussd-shop/handlers/confirm-by-text")).confirmShopBundleByText
      const res = await confirm({
        shopCodeId: offer.shop.shopCodeId,
        shopId: offer.shop.shopId,
        parentShopId: offer.shop.parentShopId,
        paystackProvider: offer.paystackProvider,
        bundleId: offer.bundleId,
        recipientLocal: offer.recipientLocal,
        senderLocal,
        messageId,
      })
      return { orderId: res.orderId, amountGhs: res.amountGhs }
    },

    quote(offer, a, ctx) {
      // Quote = the amount the order was written with (a): a figure above the verified price already holds the gateway fee.
      return shopQuoteReply({
        shopName: offer.shop.name, size: sizeLabel(offer.size), networkLabel: offer.networkLabel, recipientLocal: offer.recipientLocal,
        amountGhs: a.amountGhs, feeOnTop: ctx.feeOnTop && !(a.amountGhs > offer.price + 0.005), payerNetwork: ctx.payerNetwork,
      })
    },

    notPlacedReply: (offer) => shopOffReply(offer.shop.name),
    readOrder: (db, orderId) => orderRowFor(db, "ussd_shop_orders", orderId),
    classify: classifyOrder,
    statusOf: (link, row) => orderStatusOf(link, row),
    notices: {
      unpaid: unpaidReply,
      delivered: (l) => (l.gift ? deliveredGiftReply(l.size, l.recipient) : null),
      paidNotDelivered: paidNotDeliveredReply,
    },
  }
}
