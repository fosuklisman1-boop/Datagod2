// Hubtel menu text. Deliberately separate from lib/ussd/menus.ts: Hubtel uses REAL
// network names and normal wording (no Uzo nicknames / "Browse Services" rebrand).
import { MenuItemDef, ResolvedMenuItem, renderMenuText, resolveMenuItems } from "@/lib/ussd/menu-items"
import type { BundleOption } from "@/lib/ussd/types"
import { DEFAULT_BRAND, DEFAULT_WELCOME } from "./config"

export type MainMenuKey = "data" | "afa" | "airtime" | "resultsChecker"

const MAIN_ITEMS: MenuItemDef<MainMenuKey>[] = [
  { key: "data", label: "Buy Data Bundle" },
  { key: "afa", label: "AFA Registration" },
  { key: "airtime", label: "Buy Airtime" },
  { key: "resultsChecker", label: "Results Checker" },
]

/** Flip each to true as its flow ships (Plan 2). Admin visibility is ANDed with this. */
export const IMPLEMENTED_SERVICES: Record<MainMenuKey, boolean> = {
  data: true,
  afa: true,
  airtime: true,
  resultsChecker: true,
}

export function resolveMainMenu(
  visibility: Record<MainMenuKey, boolean>,
  dataBlocked: boolean
): ResolvedMenuItem<MainMenuKey>[] {
  const visible: Record<MainMenuKey, boolean> = {
    data: visibility.data && IMPLEMENTED_SERVICES.data && !dataBlocked,
    afa: visibility.afa && IMPLEMENTED_SERVICES.afa,
    airtime: visibility.airtime && IMPLEMENTED_SERVICES.airtime,
    resultsChecker: visibility.resultsChecker && IMPLEMENTED_SERVICES.resultsChecker,
  }
  return resolveMenuItems(MAIN_ITEMS, visible)
}

/** The admin welcome line (config.welcome, already validated); empty/missing falls back to the default. */
function welcomeLine(welcome: string): string {
  return (typeof welcome === "string" && welcome.trim()) || DEFAULT_WELCOME
}

/** The admin brand (config.brandName, already validated); empty/missing falls back to the default. */
export function brandText(brandName: string): string {
  return (typeof brandName === "string" && brandName.trim()) || DEFAULT_BRAND
}

/** Goodbye when the caller picks "0" on the main menu. */
export function mainExitText(brandName: string): string {
  return `Thank you for using ${brandText(brandName)}.`
}

/** `welcome` is config.welcome: required so no render path can forget it. */
export function mainMenuText(resolved: ResolvedMenuItem<MainMenuKey>[], welcome: string): string {
  return renderMenuText(welcomeLine(welcome), resolved, "0. Exit")
}

export const HUBTEL_NETWORKS = [
  { digit: "1", dbName: "MTN", label: "MTN" },
  { digit: "2", dbName: "Telecel", label: "Telecel" },
  { digit: "3", dbName: "AT-iShare", label: "AT iShare" },
  { digit: "4", dbName: "AT-BigTime", label: "AT BigTime" },
] as const

export function networkMenuText(): string {
  return "Select Network:\n" + HUBTEL_NETWORKS.map(n => `${n.digit}. ${n.label}`).join("\n") + "\n0. Back"
}

/** Bare numbers are GB; strings that already carry a unit are left alone. */
export function formatSize(size: string): string {
  return /^\d+(\.\d+)?$/.test(size.trim()) ? `${size.trim()}GB` : size.trim()
}

export function bundleMenuText(bundles: BundleOption[], page: number, total: number, pageSize: number): string {
  const offset = page * pageSize
  const lines = bundles.map((b, i) => `${offset + i + 1}. ${formatSize(b.size)} - GHS ${b.price.toFixed(2)}`)
  if (offset + bundles.length < total) lines.push(`${offset + bundles.length + 1}. More...`)
  lines.push("0. Back")
  return "Select Package:\n" + lines.join("\n")
}

export function recipientPromptText(): string {
  return "Enter recipient number\n(who gets the bundle):\n0. Back"
}

export function confirmMenuText(
  networkLabel: string,
  size: string,
  price: number,
  recipientLocal: string,
  dialingLocal: string
): string {
  return (
    `Confirm order:\n${formatSize(size)} ${networkLabel}\nTo: ${recipientLocal}\n` +
    `GHS ${price.toFixed(2)} from ${dialingLocal}\n1. Pay now\n2. Cancel`
  )
}

// Airtime networks (lib/airtime-pricing.ts vocabulary: "AT" is AirtelTigo).
export type AirtimeNetworkKey = "MTN" | "Telecel" | "AT"
export const AIRTIME_NETWORKS: ReadonlyArray<{ digit: string; key: AirtimeNetworkKey; label: string }> = [
  { digit: "1", key: "MTN", label: "MTN" },
  { digit: "2", key: "Telecel", label: "Telecel" },
  { digit: "3", key: "AT", label: "AT" },
]

export function airtimeLabel(network: string): string {
  return AIRTIME_NETWORKS.find(n => n.key === network)?.label ?? network
}

/** Results Checker sub-menu. */
export function rcMenuText(): string {
  return "Results Checker\n1. Buy Vouchers\n2. My Vouchers\n3. Check Results\n0. Back"
}

// -- Shop mode (Plan 3) -------------------------------------------------------
// The shop product menu has no AFA (same as the Uzo shop code). Hubtel wording, not the Uzo
// "Browse Services" rebrand.
export type ShopMenuKey = "data" | "airtime" | "resultsChecker"

const SHOP_ITEMS: MenuItemDef<ShopMenuKey>[] = [
  { key: "data", label: "Buy Data Bundle" },
  { key: "airtime", label: "Buy Airtime" },
  { key: "resultsChecker", label: "Results Checker" },
]

/** Hubtel admin visibility (afa ignored) AND built AND, for data, not whitelist-blocked. */
export function resolveShopMenu(
  visibility: Record<MainMenuKey, boolean>,
  dataBlocked: boolean
): ResolvedMenuItem<ShopMenuKey>[] {
  return resolveMenuItems(SHOP_ITEMS, {
    data: visibility.data && IMPLEMENTED_SERVICES.data && !dataBlocked,
    airtime: visibility.airtime && IMPLEMENTED_SERVICES.airtime,
    resultsChecker: visibility.resultsChecker && IMPLEMENTED_SERVICES.resultsChecker,
  })
}

export const SHOP_NAME_MAX = 30

/** Shop display name for a screen header: printable ASCII, single spaces, at most 30 chars. */
export function shopHeader(shopName: string): string {
  const clean = shopName.replace(/[^\x20-\x7E]/g, "").replace(/\s+/g, " ").trim().slice(0, SHOP_NAME_MAX).trim()
  return clean || "Shop"
}

/** `welcome` is config.welcome; later shop screens show the shop's own name instead. */
export function shopCodePromptText(welcome: string): string {
  return `${welcomeLine(welcome)}\nEnter shop code:\n0. Exit`
}

export function shopCodeRetryText(reason: string): string {
  return `${reason}\nEnter shop code:\n0. Exit`
}

export function shopMenuText(shopName: string, resolved: ResolvedMenuItem<ShopMenuKey>[]): string {
  return renderMenuText(`${shopHeader(shopName)}\nWhat would you like to buy?`, resolved, "0. Exit")
}

/** Real name for a packages.network value; values Hubtel does not list are shown as stored. */
export function shopNetworkLabel(dbName: string): string {
  return HUBTEL_NETWORKS.find(n => n.dbName === dbName)?.label ?? dbName
}

/** HUBTEL_NETWORKS order first, anything else after it alphabetically. */
export function sortShopNetworks(networks: string[]): string[] {
  const rank = (n: string) => {
    const i = HUBTEL_NETWORKS.findIndex(h => h.dbName === n)
    return i === -1 ? HUBTEL_NETWORKS.length : i
  }
  return [...networks].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
}

export function shopNetworkMenuText(shopName: string, networks: string[]): string {
  const lines = networks.map((n, i) => `${i + 1}. ${shopNetworkLabel(n)}`)
  return `${shopHeader(shopName)}\nSelect Network:\n` + lines.join("\n") + "\n0. Back"
}
