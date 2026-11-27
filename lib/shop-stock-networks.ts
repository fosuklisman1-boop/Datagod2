// A shop's network list drops networks with no available packages. When the admin marked a network
// out of stock, the shop should keep showing it (customers then see the reason) — but only if the shop
// actually sells that network. Shared by the USSD shop codes and the storefront.
import { noticeFor, type StockNotices } from "./network-stock-notice"

/**
 * `available` (today's list) plus every network in `sold` (what the shop sells, ignoring
 * admin availability) that has an out-of-stock notice. Order: available first, then additions in
 * `sold` order. Callers keep their own display sorting.
 */
export function mergeStockedOutNetworks(available: string[], sold: string[], notices: StockNotices): string[] {
  const out = [...available]
  for (const network of sold) {
    if (!out.includes(network) && noticeFor(notices, network) !== null) out.push(network)
  }
  return out
}

/** Only the notices for networks this shop sells, keyed by the shop's own network name. */
export function noticesForShop(sold: string[], notices: StockNotices): StockNotices {
  const out: StockNotices = {}
  for (const network of sold) {
    const text = noticeFor(notices, network)
    if (text !== null) out[network] = text
  }
  return out
}
