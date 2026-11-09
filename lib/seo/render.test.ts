import { describe, it, expect, vi } from "vitest"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"

vi.mock("@/lib/supabase", () => ({ supabase: { auth: { getSession: async () => ({ data: {} }) } }, supabaseAdmin: {} }))

import { buildPriceGroups } from "./data-prices"
import { PriceTable } from "@/components/seo/price-table"
import { Comparison } from "@/components/seo/comparison"

const ADJ = { price_adjustment_mtn: 0, price_adjustment_telecel: 0, price_adjustment_at_ishare: 0, price_adjustment_at_bigtime: 0 }
// Bare-number sizes, exactly as the platform stores them.
const prices = buildPriceGroups(
  [
    { network: "MTN", size: "1", price: 5, is_available: true },
    { network: "MTN", size: "2", price: 9, is_available: true },
    { network: "Telecel", size: "1", price: 6, is_available: true },
  ],
  ADJ,
)

describe("server render with bare-number package sizes", () => {
  it("PriceTable shows 1GB and a per-GB value", () => {
    const html = renderToStaticMarkup(createElement(PriceTable, { name: "MTN", groups: prices.MTN, loadedAt: "2026-10-28T00:00:00Z" }))
    expect(html).toContain("1GB")
    expect(html).toContain("2GB")
    expect(html).toContain("GH₵4.50")
    expect(html).not.toContain("NaN")
    expect(html).not.toContain("undefined")
    expect(html).not.toContain("—")
  })

  it("Comparison shows sizes with units and per-GB values", () => {
    const html = renderToStaticMarkup(createElement(Comparison, { prices, loadedAt: "2026-10-28T00:00:00Z" }))
    expect(html).toContain("2GB for GH₵9.00")
    expect(html).toContain("GH₵4.50")
    expect(html).not.toContain("NaN")
    expect(html).not.toContain("undefined")
  })
})
