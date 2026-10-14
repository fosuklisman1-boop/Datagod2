import type { HubtelQueryItem } from "@/lib/hubtel-cs/types"
import type { HubtelCsServiceKey } from "@/lib/hubtel-cs/services"

export type BundleNetwork = "MTN" | "TELECEL" | "AT"

export const BUNDLE_NETWORKS: readonly BundleNetwork[] = ["MTN", "TELECEL", "AT"]

export const NETWORK_SERVICE: Record<BundleNetwork, HubtelCsServiceKey> = {
  MTN: "data_mtn",
  TELECEL: "data_telecel",
  AT: "data_at",
}

export const OTHER_CATEGORY = "Other"

export const CATEGORY_ORDER: Record<BundleNetwork, readonly string[]> = {
  MTN: ["Data", "Video", "Social Media", "Midnight", "Kokrokoo"],
  TELECEL: ["Hourly", "Daily", "Weekly", "Monthly", "No Expiry", "Night"],
  AT: ["BigTime", "Kokoo", "Fuse (Mins + Data)", "XXL Family"],
}

export interface CatalogBundle {
  /** Exact Hubtel value, never trimmed (it is sent back to Hubtel verbatim). */
  value: string
  /** Trimmed display text. */
  display: string
  amount: number
  category: string
}

function mtnCategory(value: string): string {
  if (value.includes("_Midnight_")) return "Midnight"
  if (value.includes("_Kokrokoo_")) return "Kokrokoo"
  if (value.includes("_Social_")) return "Social Media"
  if (value.includes("_Video_")) return "Video"
  if (value.includes("_Data_")) return "Data"
  return OTHER_CATEGORY
}

function telecelCategory(display: string): string {
  const sep = display.indexOf(" - ")
  const head = (sep >= 0 ? display.slice(0, sep) : display).trim()
  if (head.startsWith("No Expiry(12am")) return "Night"
  if (head === "No Expiry") return "No Expiry"
  if (head === "1 Hour") return "Hourly"
  const m = /^(\d+)\s*days?$/i.exec(head)
  if (m) {
    const n = Number(m[1])
    if (n === 1) return "Daily"
    if (n >= 2 && n <= 7) return "Weekly"
    if (n >= 8 && n <= 31) return "Monthly"
  }
  return OTHER_CATEGORY
}

function atCategory(value: string): string {
  if (value.startsWith("db_BigTime_Data_")) return "BigTime"
  if (value.startsWith("db_Fuse_")) return "Fuse (Mins + Data)"
  if (value.startsWith("db_Sika_Kokoo_")) return "Kokoo"
  if (value.startsWith("db_XXL_Family_Pack_")) return "XXL Family"
  return OTHER_CATEGORY
}

export function categoryOf(network: BundleNetwork, item: HubtelQueryItem): string {
  const value = item.Value ?? ""
  const display = item.Display ?? ""
  switch (network) {
    case "MTN":
      return mtnCategory(value)
    case "TELECEL":
      return telecelCategory(display)
    case "AT":
      return atCategory(value)
  }
}

function rank(network: BundleNetwork, category: string): number {
  const i = CATEGORY_ORDER[network].indexOf(category)
  return i === -1 ? CATEGORY_ORDER[network].length : i
}

export function parseCatalog(network: BundleNetwork, items: HubtelQueryItem[]): CatalogBundle[] {
  const out: CatalogBundle[] = []
  for (const item of items) {
    const value = item?.Value
    const amount = item?.Amount
    if (typeof value !== "string" || value.trim() === "") continue
    if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) continue
    out.push({
      value,
      display: (item.Display ?? "").trim(),
      amount,
      category: categoryOf(network, item),
    })
  }
  return out.sort(
    (a, b) => rank(network, a.category) - rank(network, b.category) || a.amount - b.amount,
  )
}
