// Compares the price a storefront page sent with the server-verified price, in whole pesewas.
//
// - "match": within 1 pesewa (rounding).
// - "stale": the page asked for MORE than the real price — a page left open while the shop changed its prices.
//   The buyer would have overpaid; not fraud. Reject with "price changed, refresh" and no fraud alert.
// - "under": the page asked for LESS than the real price — possible tampering. Reject and alert admins.
export type PriceCheck = "match" | "stale" | "under"

export function checkClientPrice(clientPrice: number, serverPrice: number): PriceCheck {
  const client = Math.round(Number(clientPrice) * 100)
  const server = Math.round(Number(serverPrice) * 100)
  if (!Number.isFinite(client)) return "under"
  if (Math.abs(client - server) <= 1) return "match"
  return client > server ? "stale" : "under"
}
