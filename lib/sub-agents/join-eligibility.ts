// Who can join: the shop being joined, and the person joining.

export type JoinTargetShop = {
  is_active: boolean
  is_blocked: boolean
  parent_shop_id: string | null
}

/** A shop can be joined only when open join is on and it is an active, unblocked top-level shop. */
export function targetStatus(shop: JoinTargetShop | null, enabled: boolean): "open" | "closed" {
  if (!enabled || !shop) return "closed"
  if (!shop.is_active || shop.is_blocked || shop.parent_shop_id) return "closed"
  return "open"
}

/** Dealers and admins never join as sub-agents; anyone who already owns a shop cannot join again. */
export function joinerStatus(user: { role: string; hasShop: boolean }): "can_join" | "has_shop" | "not_allowed" {
  if (user.role === "dealer" || user.role === "admin") return "not_allowed"
  if (user.hasShop) return "has_shop"
  return "can_join"
}
