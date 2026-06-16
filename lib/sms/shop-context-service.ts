/**
 * Shop context for the tenant SMS composer: the merge-token values ({shop_name},
 * {shop_link}, {shop_phone}, {shop_whatsapp}) and the shop's customer phone list
 * ("My Customers"). Resolved from the account's owning shop (user_shops).
 *
 * Service-role only; called from tenant routes that have already authenticated
 * the caller and resolved their account.
 */

import { createClient } from "@supabase/supabase-js"
import type { ShopTokens } from "./prepare"
import type { SmsAccount } from "./account-service"

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const APP_URL = (process.env.NEXT_PUBLIC_APP_URL || "https://datagod.store").replace(/\/$/, "")
const ROOT_DOMAIN = APP_URL.replace(/^https?:\/\//, "").replace(/^www\./, "")

const EMPTY_TOKENS: ShopTokens = { shop_name: "", shop_link: "", shop_phone: "", shop_whatsapp: "" }

export interface ShopCustomer {
  phone: string
  name: string | null
}

export interface ShopContext {
  tokens: ShopTokens
  customers: ShopCustomer[]
  hasShop: boolean
}

/** Resolve the user_shops row backing this account (by owner_id, else by user_id). */
async function resolveShop(account: Pick<SmsAccount, "owner_id" | "user_id">) {
  if (account.owner_id) {
    const { data } = await supabaseAdmin
      .from("user_shops")
      .select("id, shop_name, shop_slug, subdomain")
      .eq("id", account.owner_id)
      .maybeSingle()
    if (data) return data
  }
  const { data } = await supabaseAdmin
    .from("user_shops")
    .select("id, shop_name, shop_slug, subdomain")
    .eq("user_id", account.user_id)
    .maybeSingle()
  return data
}

/** Build the {shop_*} merge-token values for an account's shop. Empty strings when unknown. */
export async function getShopTokens(account: SmsAccount): Promise<ShopTokens> {
  const shop = await resolveShop(account)
  if (!shop) return EMPTY_TOKENS

  const shopRow = shop as { id: string; shop_name: string | null; shop_slug: string | null; subdomain: string | null }

  // Storefront link: a configured subdomain wins, else the /shop/<slug> path.
  const shop_link = shopRow.subdomain
    ? `https://${shopRow.subdomain}.${ROOT_DOMAIN}`
    : shopRow.shop_slug
      ? `${APP_URL}/shop/${shopRow.shop_slug}`
      : APP_URL

  // Contact details live across settings + the owner's profile.
  const [{ data: settings }, { data: owner }] = await Promise.all([
    supabaseAdmin.from("shop_settings").select("whatsapp_link").eq("shop_id", shopRow.id).maybeSingle(),
    supabaseAdmin.from("users").select("phone_number").eq("id", account.user_id).maybeSingle(),
  ])

  return {
    shop_name: shopRow.shop_name ?? "",
    shop_link,
    shop_phone: (owner as { phone_number?: string } | null)?.phone_number ?? "",
    shop_whatsapp: (settings as { whatsapp_link?: string } | null)?.whatsapp_link ?? "",
  }
}

/** List the shop's customers (most-recent first) for the "My Customers" picker. */
export async function listShopCustomers(account: SmsAccount, limit = 500): Promise<ShopCustomer[]> {
  const shop = await resolveShop(account)
  if (!shop) return []

  const { data } = await supabaseAdmin
    .from("shop_customers")
    .select("phone_number, customer_name, last_purchase_at")
    .eq("shop_id", (shop as { id: string }).id)
    .order("last_purchase_at", { ascending: false, nullsFirst: false })
    .limit(limit)

  return (data ?? [])
    .filter((c: { phone_number: string | null }) => !!c.phone_number)
    .map((c: { phone_number: string; customer_name: string | null }) => ({
      phone: c.phone_number,
      name: c.customer_name ?? null,
    }))
}

/** Full composer context in one call: tokens, customers, and whether a shop was found. */
export async function getShopContext(account: SmsAccount): Promise<ShopContext> {
  const [tokens, customers] = await Promise.all([getShopTokens(account), listShopCustomers(account)])
  const hasShop = tokens.shop_name !== "" || customers.length > 0
  return { tokens, customers, hasShop }
}
