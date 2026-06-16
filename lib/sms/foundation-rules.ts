export type OwnerType = "platform" | "shop" | "sub_agent"
export type BundleScope = "all" | OwnerType

export interface OwnerInput {
  role: string
  ownsShop: boolean
  isSubAgent: boolean
  shopId?: string
  subAgentId?: string
}

export interface OwnerContext {
  ownerType: OwnerType
  ownerId: string | null
}

/** Decide which SMS-account tenant a user belongs to. Admin wins over shop/sub-agent. */
export function deriveOwnerType(input: OwnerInput): OwnerContext | null {
  if (input.role === "admin") return { ownerType: "platform", ownerId: null }
  if (input.ownsShop) return { ownerType: "shop", ownerId: input.shopId ?? null }
  if (input.isSubAgent) return { ownerType: "sub_agent", ownerId: input.subAgentId ?? null }
  return null
}

export interface BundleLike {
  id: string
  active: boolean
  owner_type_scope: BundleScope
}

export function canPurchaseBundle(
  bundle: BundleLike,
  ownerType: OwnerType
): { ok: true } | { ok: false; reason: string } {
  if (!bundle.active) return { ok: false, reason: "Bundle is not available" }
  if (bundle.owner_type_scope !== "all" && bundle.owner_type_scope !== ownerType) {
    return { ok: false, reason: "Bundle not available for this account type" }
  }
  return { ok: true }
}
