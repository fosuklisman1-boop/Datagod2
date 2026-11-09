import { secureString } from "@/lib/secure-random"

export interface CreateSubAgentShopOpts {
  userId: string
  parent: { id: string; shop_name: string; tier_level: number }
  shopName: string
  shopSlug: string
  via: "storefront" | "invite"
  dealerRatesEnabled: boolean
}

export class SubAgentSlugTakenError extends Error {
  constructor() {
    super("Shop slug is already taken")
    this.name = "SubAgentSlugTakenError"
  }
}

/**
 * Creates the user's wallet. A unique violation means one already exists (e.g. made by a
 * trigger), which counts as success; any other error throws.
 */
export async function ensureWallet(db: any, userId: string): Promise<void> {
  const now = new Date().toISOString()
  const { error } = await db.from("wallets").insert({
    user_id: userId,
    balance: 0,
    total_credited: 0,
    total_spent: 0,
    created_at: now,
    updated_at: now,
  })
  if (error && error.code !== "23505") throw error
}

/** Base name slugified plus a random 4-character suffix. */
export function makeShopSlug(name: string): string {
  const base = (name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "") || "shop"
  const suffix = secureString(4, "abcdefghjkmnpqrstuvwxyz23456789")
  return `${base}-${suffix}`
}

/**
 * Creates the sub-agent's shop under `parent`.
 * - storefront: closed (is_active=false), joined_via='storefront', no packages copied.
 * - invite: active, joined_via NULL, parent's available packages copied at 0 margin.
 * A unique violation on user_id returns the user's existing shop untouched (created=false);
 * a unique violation with no shop for this user is a slug collision and throws SubAgentSlugTakenError.
 */
export async function createSubAgentShop(
  db: any,
  opts: CreateSubAgentShopOpts
): Promise<{ shopId: string; slug: string; created: boolean }> {
  const { userId, parent, shopName, via } = opts
  const slug = opts.shopSlug.toLowerCase()

  const { data: newShop, error } = await db
    .from("user_shops")
    .insert({
      user_id: userId,
      shop_name: shopName,
      shop_slug: slug,
      parent_shop_id: parent.id,
      tier_level: (parent.tier_level || 1) + 1,
      is_active: via === "invite",
      joined_via: via === "storefront" ? "storefront" : null,
      dealer_rates_enabled: opts.dealerRatesEnabled,
      description: `Sub-agent of ${parent.shop_name}`,
    })
    .select()
    .single()

  if (error || !newShop) {
    if (error?.code === "23505") {
      const { data: existing } = await db
        .from("user_shops")
        .select("id, shop_slug")
        .eq("user_id", userId)
        .maybeSingle()
      if (existing) return { shopId: existing.id, slug: existing.shop_slug, created: false }
      throw new SubAgentSlugTakenError()
    }
    throw error ?? new Error("Failed to create shop")
  }

  if (via === "invite") {
    // Sub-agent's base price = parent's selling price; they start at 0 margin.
    const { data: parentPackages, error: packagesError } = await db
      .from("shop_packages")
      .select("package_id")
      .eq("shop_id", parent.id)
      .eq("is_available", true)

    if (!packagesError && parentPackages) {
      // One row per package: shop_packages is UNIQUE(shop_id, package_id) (migration 0144).
      const ids = [...new Set<string>(parentPackages.map((p: any) => p.package_id))]
      if (ids.length > 0) {
        await db.from("shop_packages").insert(
          ids.map(package_id => ({
            shop_id: newShop.id,
            package_id,
            profit_margin: 0,
            is_available: true,
          }))
        )
      }
    }
  }

  return { shopId: newShop.id, slug: newShop.shop_slug, created: true }
}
