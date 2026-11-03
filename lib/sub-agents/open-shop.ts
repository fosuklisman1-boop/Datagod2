import { createClient } from "@supabase/supabase-js"
import { marginsValid, subAgentCosts } from "@/lib/shop-commerce/pricing"
import { CustomPriceReadError } from "@/lib/pricing/package-price"
import { shopHandleOrFilter } from "@/lib/shop-handle"

// A closed storefront joiner is is_active=false + joined_via='storefront' + prices_set_at IS NULL (migration 0146).
// Selling channels refuse is_active=false because of the is_active filters added in this branch and the effective
// status resolveShopCode returns (inactive/suspended, and inactive when the shop read fails). "Open" is a one-time
// latch: the first time the joiner has a priced package, is_active and prices_set_at are set together. A later
// catalog change never closes the shop.
// All writes here need the service role: the 0146 trigger blocks owners from changing these columns.

function serviceClient() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
}

export class ShopNotFoundError extends Error {
  constructor() {
    super("Shop not found")
    this.name = "ShopNotFoundError"
  }
}

export type OpenShopStatus = "opened" | "already_open" | "no_prices" | "blocked"
export interface OpenShopResult {
  status: OpenShopStatus
  ussdCode?: string
  subdomain?: string
}

const SHOP_COLUMNS = "id, is_active, is_blocked, joined_via, prices_set_at, parent_shop_id, subdomain"

/**
 * At least one active sub_agent_shop_packages row with a valid (finite, >= 0) margin whose package the parent
 * still offers, priced live by subAgentCosts. A stored parent_price is never read.
 * Throws CustomPriceReadError when the rows or the parent's offer cannot be read (retryable, never "no prices").
 */
async function hasPricedPackage(db: any, shopId: string, parentShopId: string): Promise<boolean> {
  const { data: rows, error } = await db
    .from("sub_agent_shop_packages")
    .select("package_id, sub_agent_profit_margin")
    .eq("shop_id", shopId)
    .eq("is_active", true)
  if (error || !Array.isArray(rows)) throw new CustomPriceReadError("Could not read the shop's saved prices")

  const ids = [...new Set<string>(
    rows
      .filter((r: any) => r.sub_agent_profit_margin != null && marginsValid(Number(r.sub_agent_profit_margin)))
      .map((r: any) => String(r.package_id))
  )]
  if (ids.length === 0) return false

  const { costs } = await subAgentCosts(parentShopId, ids, db)
  return ids.some(id => costs.get(id) != null)
}

/** The shop's USSD code and subdomain for the "your shop is open" screen. A failed code read is not fatal. */
async function shopLinks(db: any, shop: { id: string; subdomain?: string | null }): Promise<Omit<OpenShopResult, "status">> {
  let ussdCode: string | undefined
  try {
    const { data } = await db.from("ussd_shop_codes").select("code").eq("shop_id", shop.id).maybeSingle()
    if (data?.code) ussdCode = String(data.code)
  } catch {
    /* the shop is open either way; the dashboard shows the code */
  }
  return { ussdCode, subdomain: shop.subdomain ?? undefined }
}

/**
 * Opens the user's storefront-joiner shop once it has a priced package.
 * - already_open: the shop is already active (no write).
 * - blocked: blocked, or not a closed storefront joiner (an invite or main shop awaiting approval, or a joiner an
 *   admin closed after it opened); none of these can open themselves here.
 * - no_prices: nothing priced yet.
 * Throws ShopNotFoundError when the user has no shop, CustomPriceReadError when prices cannot be read (retryable).
 */
export async function openPricedShop(db: any, userId: string): Promise<OpenShopResult> {
  const { data: shop, error } = await db.from("user_shops").select(SHOP_COLUMNS).eq("user_id", userId).maybeSingle()
  if (error) throw new Error("Could not read the shop")
  if (!shop) throw new ShopNotFoundError()

  if (shop.is_blocked === true) return { status: "blocked" }
  if (shop.is_active === true) return { status: "already_open", ...(await shopLinks(db, shop)) }
  if (shop.joined_via !== "storefront" || shop.prices_set_at != null || !shop.parent_shop_id) {
    return { status: "blocked" }
  }

  if (!(await hasPricedPackage(db, shop.id, shop.parent_shop_id))) return { status: "no_prices" }

  // Conditional latch: only a still-closed, unpriced, unblocked joiner opens, so a double submit writes once
  // and a block that lands in between wins.
  const now = new Date().toISOString()
  const { data: opened, error: updateError } = await db
    .from("user_shops")
    .update({ is_active: true, prices_set_at: now, updated_at: now })
    .eq("id", shop.id)
    .eq("joined_via", "storefront")
    .eq("is_active", false)
    .is("prices_set_at", null)
    .not("is_blocked", "is", true)
    .select("id")
  if (updateError) throw new Error("Could not open the shop")

  if (!Array.isArray(opened) || opened.length === 0) {
    const { data: current } = await db.from("user_shops").select(SHOP_COLUMNS).eq("id", shop.id).maybeSingle()
    if (current?.is_active === true && current.is_blocked !== true) {
      return { status: "already_open", ...(await shopLinks(db, current)) }
    }
    return { status: "blocked" }
  }

  return { status: "opened", ...(await shopLinks(db, shop)) }
}

export type ShopPublicState = "open" | "setting_up" | "missing"

/**
 * What a storefront visitor should see for a handle. Active: open. An unpriced, unblocked storefront joiner:
 * setting_up ("This shop isn't open yet"). Anything else inactive, blocked-and-closed, unknown or ambiguous: missing.
 * Reads with the service role because visitors cannot read inactive shops. Never throws.
 */
export async function getShopPublicState(handle: string, db: any = null): Promise<ShopPublicState> {
  if (typeof handle !== "string" || !handle.trim()) return "missing"
  try {
    const client = db ?? serviceClient()
    const { data, error } = await client
      .from("user_shops")
      .select("is_active, is_blocked, joined_via, prices_set_at")
      .or(shopHandleOrFilter(handle.trim()))
      .limit(2)
    if (error || !Array.isArray(data) || data.length !== 1) return "missing"
    const s = data[0]
    if (s.is_active === true) return "open"
    if (s.joined_via === "storefront" && s.prices_set_at == null && s.is_blocked !== true) return "setting_up"
    return "missing"
  } catch {
    return "missing"
  }
}

// ───────────────────────── admin queue ─────────────────────────

export type AdminShopStatus = "pending" | "active" | "storefront_joiners" | null

/**
 * Status filter for /api/admin/shops. Pending is the approval queue: inactive shops that did not join through a
 * storefront (joiners open by pricing, never by approval). The CHECK on joined_via allows only NULL or 'storefront'.
 */
export function applyAdminShopStatus<Q extends { eq: Function; is: Function }>(query: Q, status: string | null): Q {
  if (status === "pending") return (query.eq("is_active", false) as Q).is("joined_via", null) as Q
  if (status === "active") return query.eq("is_active", true) as Q
  if (status === "storefront_joiners") return query.eq("joined_via", "storefront") as Q
  return query
}

export const ADMIN_SHOP_COLUMNS =
  "id, shop_name, subdomain, shop_slug, description, is_active, is_blocked, block_reason, created_at, user_id, joined_via, prices_set_at, parent_shop_id"

/** Recent storefront joiners, newest first, each with its parent shop's name. Throws on a read error. */
export async function listStorefrontJoiners(db: any, limit: number): Promise<any[]> {
  const { data, error } = await applyAdminShopStatus(db.from("user_shops").select(ADMIN_SHOP_COLUMNS), "storefront_joiners")
    .order("created_at", { ascending: false })
    .range(0, Math.max(0, limit - 1))
  if (error) throw new Error(error.message || "Could not read storefront joiners")
  const rows: any[] = data || []

  const parentIds = [...new Set(rows.map(r => r.parent_shop_id).filter(Boolean))]
  let parents: Record<string, string> = {}
  if (parentIds.length > 0) {
    const { data: parentRows } = await db.from("user_shops").select("id, shop_name").in("id", parentIds)
    parents = Object.fromEntries((parentRows || []).map((p: any) => [p.id, p.shop_name]))
  }
  return rows.map(r => ({ ...r, parent_shop_name: r.parent_shop_id ? parents[r.parent_shop_id] ?? null : null }))
}

export type ApproveShopResult =
  | { status: "approved"; shop: any }
  | { status: "already_approved" }
  | { status: "opens_when_priced" }

/**
 * Admin approval. Only an inactive shop that is not a closed storefront joiner is activated (conditional update,
 * so a double click cannot notify twice and a joiner can never be approved without prices).
 */
export async function approveShop(db: any, shopId: string): Promise<ApproveShopResult> {
  const { data, error } = await db
    .from("user_shops")
    .update({ is_active: true, updated_at: new Date().toISOString() })
    .eq("id", shopId)
    .eq("is_active", false)
    .or("joined_via.is.null,prices_set_at.not.is.null")
    .select("*")
  if (error) throw new Error(error.message || "Could not approve the shop")
  if (Array.isArray(data) && data.length > 0) return { status: "approved", shop: data[0] }

  const { data: shop } = await db
    .from("user_shops")
    .select("is_active, joined_via, prices_set_at")
    .eq("id", shopId)
    .maybeSingle()
  if (shop && shop.is_active !== true && shop.joined_via === "storefront" && shop.prices_set_at == null) {
    return { status: "opens_when_priced" }
  }
  return { status: "already_approved" }
}

/**
 * What removing a sub-agent writes. An invited sub-agent is only detached, as before. A storefront joiner skipped
 * admin approval, so detaching them would leave an unreviewed main shop: they are closed, lose the storefront flag
 * and dealer rates, and land in the normal admin approval queue.
 */
export function subAgentRemovalUpdate(subAgent: { joined_via?: string | null }): Record<string, unknown> {
  if (subAgent.joined_via === "storefront") {
    return { parent_shop_id: null, tier_level: 1, is_active: false, joined_via: null, dealer_rates_enabled: false }
  }
  return { parent_shop_id: null, tier_level: 1 }
}
