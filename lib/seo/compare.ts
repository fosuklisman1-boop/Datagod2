/**
 * Cross-network comparison of DATAGOD's own live prices (adjusted customer
 * prices). Pure; never refers to anyone else's prices.
 */
import type { PriceGroups, PriceRow } from "./data-prices"

type Net = "MTN" | "Telecel" | "AT"

export const COMPARE_NETWORKS: readonly Net[] = ["MTN", "Telecel", "AT"]
export const COMPARE_SIZES = [1, 2, 5, 10] as const

export interface Comparison {
  best: Array<{ network: Net; perGb: number; size: string; label: string; price: number }>
  sizes: Array<{ gb: 1 | 2 | 5 | 10; cells: Record<Net, number | null> }>
}

export function buildComparison(prices: PriceGroups): Comparison {
  const rowsOf = (net: Net): PriceRow[] => prices[net].flatMap((g) => g.rows)

  const best: Comparison["best"] = []
  for (const network of COMPARE_NETWORKS) {
    let top: PriceRow | null = null
    for (const r of rowsOf(network)) {
      if (r.perGb === null) continue
      if (top === null || r.perGb < (top.perGb as number) || (r.perGb === top.perGb && r.price < top.price)) top = r
    }
    if (top) best.push({ network, perGb: top.perGb as number, size: top.size, label: top.label, price: top.price })
  }

  const sizes: Comparison["sizes"] = []
  for (const gb of COMPARE_SIZES) {
    const cells = {} as Record<Net, number | null>
    for (const network of COMPARE_NETWORKS) {
      const matches = rowsOf(network).filter((r) => r.gb === gb).map((r) => r.price)
      cells[network] = matches.length ? Math.min(...matches) : null
    }
    if (COMPARE_NETWORKS.some((n) => cells[n] !== null)) sizes.push({ gb, cells })
  }

  return { best, sizes }
}
