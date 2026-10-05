// Hubtel menu text. Deliberately separate from lib/ussd/menus.ts: Hubtel uses REAL
// network names and normal wording (no Uzo nicknames / "Browse Services" rebrand).
import { MenuItemDef, ResolvedMenuItem, renderMenuText, resolveMenuItems } from "@/lib/ussd/menu-items"
import type { BundleOption } from "@/lib/ussd/types"

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
  afa: false,
  airtime: false,
  resultsChecker: false,
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

export function mainMenuText(resolved: ResolvedMenuItem<MainMenuKey>[]): string {
  return renderMenuText("Welcome to Datagod", resolved, "0. Exit")
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
