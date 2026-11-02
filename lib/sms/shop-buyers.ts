// lib/sms/shop-buyers.ts
// "Shop buyers" broadcast audience (spec: docs/superpowers/specs/2026-11-02-shop-buyers-sms-broadcast-design.md).
// Pure helpers (phone key, subdomain link, token rendering) plus paged readers over the
// shop_buyer_audience / shop_buyer_counts functions from migration 0145.
import type { SupabaseClient } from "@supabase/supabase-js"

export const SHOP_TOKENS = ["[ShopName]", "[ShopLink]"] as const

/** Last 9 digits of a Ghana mobile (0XXXXXXXXX / 233… / +233…), or null when it isn't one. */
export function phoneKey(raw: string | null | undefined): string | null {
  const key = String(raw ?? "").replace(/\D/g, "").slice(-9)
  return /^[25][0-9]{8}$/.test(key) ? key : null
}

/** Local 0XXXXXXXXX form of a phone key. */
export const localPhone = (key: string) => `0${key}`

/** The shop's Datagod subdomain storefront, e.g. https://kofidata.datagod.store. */
export function shopSubdomainLink(subdomain: string): string {
  const root = (process.env.NEXT_PUBLIC_ROOT_DOMAIN || "datagod.store").toLowerCase()
  return `https://${subdomain}.${root}`
}

export function hasShopTokens(message: string): boolean {
  return SHOP_TOKENS.some((t) => message.includes(t))
}

/**
 * Fill [ShopName], [ShopLink] and [Phone]. Function replacers, as in personalize(): a string
 * replacement would interpret $&, $` etc. inside a shop name.
 */
export function renderShopTokens(message: string, v: { shopName: string; shopLink: string; phone: string }): string {
  return message
    .replaceAll("[ShopName]", () => v.shopName)
    .replaceAll("[ShopLink]", () => v.shopLink)
    .replaceAll("[Phone]", () => v.phone)
}

/** Window choices offered in admin; null = all time. */
export const SINCE_DAYS = [30, 90, 180] as const
export type SinceDays = (typeof SINCE_DAYS)[number]

export function parseSinceDays(v: unknown): SinceDays | null | "invalid" {
  if (v === undefined || v === null || v === "" || v === "all") return null
  const n = Number(v)
  return (SINCE_DAYS as readonly number[]).includes(n) ? (n as SinceDays) : "invalid"
}

export function sinceIso(days: SinceDays | null, now: number = Date.now()): string | null {
  return days === null ? null : new Date(now - days * 86_400_000).toISOString()
}

export interface ShopInfo {
  id: string
  name: string
  subdomain: string
  link: string
}

/** PostgREST caps every response at 1000 rows: page set-returning RPCs with .range(). */
const PAGE = 1000

async function pagedRpc<T>(client: SupabaseClient, fn: string, args: Record<string, unknown>): Promise<T[]> {
  const out: T[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await client.rpc(fn, args).range(from, from + PAGE - 1)
    if (error) throw error
    const rows = (data ?? []) as T[]
    out.push(...rows)
    if (rows.length < PAGE) return out
  }
}

/** Shop names + subdomain links, read in chunks to keep the .in() URL short. */
export async function loadShops(client: SupabaseClient, ids: string[]): Promise<Map<string, ShopInfo>> {
  const out = new Map<string, ShopInfo>()
  const unique = [...new Set(ids)]
  for (let i = 0; i < unique.length; i += 200) {
    const { data, error } = await client
      .from("user_shops")
      .select("id, shop_name, subdomain")
      .in("id", unique.slice(i, i + 200))
    if (error) throw error
    for (const s of (data ?? []) as Array<{ id: string; shop_name: string | null; subdomain: string }>) {
      out.set(s.id, { id: s.id, name: s.shop_name || "Shop", subdomain: s.subdomain, link: shopSubdomainLink(s.subdomain) })
    }
  }
  return out
}

/** Per-shop buyer counts with shop details, biggest first. */
export async function loadShopBuyerCounts(client: SupabaseClient, sinceDays: SinceDays | null) {
  const rows = await pagedRpc<{ shop_id: string; buyers: number | string }>(client, "shop_buyer_counts", {
    p_since: sinceIso(sinceDays),
  })
  const shops = await loadShops(client, rows.map((r) => r.shop_id))
  const list = rows
    .filter((r) => shops.has(r.shop_id))
    .map((r) => ({ ...shops.get(r.shop_id)!, buyers: Number(r.buyers) }))
    .sort((x, y) => y.buyers - x.buyers || x.name.localeCompare(y.name))
  return { shops: list, total: list.reduce((n, s) => n + s.buyers, 0) }
}

/** The audience for the chosen shops ("all" = every shop), as local phones with their shop. */
export async function loadShopBuyerAudience(
  client: SupabaseClient,
  opts: { shopIds: string[] | "all"; sinceDays: SinceDays | null },
): Promise<Array<{ phone: string; shop: ShopInfo }>> {
  const rows = await pagedRpc<{ phone_key: string; shop_id: string }>(client, "shop_buyer_audience", {
    p_since: sinceIso(opts.sinceDays),
    p_shop_ids: opts.shopIds === "all" ? null : opts.shopIds,
  })
  const shops = await loadShops(client, rows.map((r) => r.shop_id))
  return rows
    .filter((r) => shops.has(r.shop_id))
    .map((r) => ({ phone: localPhone(r.phone_key), shop: shops.get(r.shop_id)! }))
}

/** Count of opted-out numbers (shown next to the audience total). */
export async function countOptOuts(client: SupabaseClient): Promise<number> {
  const { count, error } = await client.from("sms_marketing_opt_outs").select("phone_key", { count: "exact", head: true })
  if (error) throw error
  return count ?? 0
}
