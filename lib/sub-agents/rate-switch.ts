// Who may flip dealer rates on a storefront joiner. Pure so the route and the page share one rule.
// ownerRole must come from users.role on the server (never metadata); ownerShopId from the session's own shop.
export function canSetDealerRates(
  ownerRole: string,
  target: { parent_shop_id: string | null; joined_via: string | null },
  ownerShopId: string
): boolean {
  if (ownerRole !== "dealer" && ownerRole !== "admin") return false
  if (!ownerShopId || target.parent_shop_id !== ownerShopId) return false
  return target.joined_via === "storefront"
}
