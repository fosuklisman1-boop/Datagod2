//
// Customer-facing text for a network the admin marked out of stock.
//
// Pure (no Supabase import) so every surface — USSD main + shop codes, the
// storefront and the dashboard — can share it. A "notice" is the line a
// customer sees in place of bundles: the admin's reason, or a default.
//
// Network names differ by surface: the DB (and the stock map) use
// "AT - iShare" / "AT - BigTime", Hubtel USSD uses "AT-iShare" / "AT-BigTime".
// Always match through stockNetworkKey().

import type { NetworkStockMap } from "./network-stock-service"

export const STOCK_REASON_MAX = 100

/** Keyed by the DB network name (e.g. "AT - iShare"). */
export type StockNotices = Record<string, string>

/** Single-line plain text, at most STOCK_REASON_MAX characters, or null when there is nothing to show. */
export function normalizeStockReason(raw: unknown): string | null {
  if (typeof raw !== "string") return null
  const clean = raw.replace(/[<>]/g, "").replace(/\s+/g, " ").trim()
  if (!clean) return null
  // Cut by code points so an emoji is never split in half.
  return Array.from(clean).slice(0, STOCK_REASON_MAX).join("").trim()
}

export function stockNetworkKey(name: string): string {
  return name.toLowerCase().replace(/\s+/g, "")
}

const LABELS: Record<string, string> = {
  mtn: "MTN",
  telecel: "Telecel",
  "at-ishare": "AT iShare",
  "at-bigtime": "AT BigTime",
}

export function stockNetworkLabel(dbName: string): string {
  return LABELS[stockNetworkKey(dbName)] ?? dbName
}

export function defaultStockReason(network: string): string {
  return `${stockNetworkLabel(network)} bundles are temporarily unavailable. Please check back soon.`
}

export function buildStockNotices(map: NetworkStockMap): StockNotices {
  const notices: StockNotices = {}
  if (!map || typeof map !== "object") return notices
  for (const [network, entry] of Object.entries(map)) {
    if (entry?.outOfStock !== true) continue
    notices[network] = normalizeStockReason(entry.reason) ?? defaultStockReason(network)
  }
  return notices
}

/**
 * The notice to show for `network` given how many of its bundles are on sale: only when none are, so
 * bundles an admin re-enables while the network is still flagged stay buyable everywhere.
 */
export function noticeWhenEmpty(notices: StockNotices, network: string, availableCount: number): string | null {
  return availableCount > 0 ? null : noticeFor(notices, network)
}

export function noticeFor(notices: StockNotices, network: string): string | null {
  const key = stockNetworkKey(network)
  for (const [name, text] of Object.entries(notices ?? {})) {
    if (stockNetworkKey(name) === key) return text
  }
  return null
}
