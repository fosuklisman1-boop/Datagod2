import { describe, it, expect } from "vitest"
import { groupAvailableProducts, buildItemListJsonLd } from "./services-hub"
import { buildLiveFacts, FAILED_RAW, type LiveFacts, type RawFacts } from "./live-facts"
import { PRODUCTS, type ProductKey } from "./products"

/** Every registry product switched on. */
function allOn(): LiveFacts {
  const f = buildLiveFacts(FAILED_RAW)
  const products = { ...f.products }
  for (const p of PRODUCTS) products[p.key] = { available: true, fromPrice: null, parts: [] }
  return { ...f, products }
}

describe("groupAvailableProducts", () => {
  it("returns the 6 groups in order with anchors when everything is on", () => {
    const groups = groupAvailableProducts(allOn())
    expect(groups.map((g) => g.group)).toEqual(["data", "airtime", "bills", "education", "business", "channels"])
    expect(groups.map((g) => g.anchor)).toEqual(["data", "airtime", "bills", "education", "business", "channels"])
    for (const g of groups) expect(g.label.length).toBeGreaterThan(0)
  })

  it("puts MTN, Telecel, AT (and AFA, registry group data) in the data group, registry order", () => {
    const data = groupAvailableProducts(allOn())[0]
    expect(data.items.map((p) => p.key)).toEqual(["mtn-data", "telecel-data", "at-data", "afa-registration"])
  })

  it("has no bills group when bills are off", () => {
    const facts = allOn()
    const keys: ProductKey[] = ["utility-bills", "ecg-prepaid", "ghana-water", "pay-dstv", "pay-gotv", "startimes", "telecel-broadband"]
    for (const k of keys) facts.products[k] = { available: false, fromPrice: null, parts: [] }
    const groups = groupAvailableProducts(facts)
    expect(groups.some((g) => g.group === "bills")).toBe(false)
    expect(groups).toHaveLength(5)
  })

  it("excludes unavailable products and drops groups that end up empty", () => {
    const facts = allOn()
    facts.products["afa-registration"] = { available: false, fromPrice: null, parts: [] }
    const groups = groupAvailableProducts(facts)
    expect(groups[0].items.map((p) => p.key)).not.toContain("afa-registration")
  })

  it("fail-closed fallback shows data, join, whatsapp, bulk-sms only", () => {
    const groups = groupAvailableProducts(buildLiveFacts(FAILED_RAW as RawFacts))
    expect(groups.map((g) => g.group)).toEqual(["data", "business", "channels"])
  })
})

describe("buildItemListJsonLd", () => {
  it("lists available products in display order with absolute urls", () => {
    const ld = buildItemListJsonLd(groupAvailableProducts(allOn())) as Record<string, any>
    expect(ld["@context"]).toBe("https://schema.org")
    expect(ld["@type"]).toBe("ItemList")
    expect(ld.itemListElement[0]).toEqual({ "@type": "ListItem", position: 1, url: "https://www.datagod.store/mtn-data", name: "MTN Data Bundles" })
    expect(ld.itemListElement).toHaveLength(PRODUCTS.length)
    expect(ld.itemListElement.map((e: any) => e.position)).toEqual(PRODUCTS.map((_, i) => i + 1))
  })

  it("is empty-safe", () => {
    expect((buildItemListJsonLd([]) as any).itemListElement).toEqual([])
  })
})
