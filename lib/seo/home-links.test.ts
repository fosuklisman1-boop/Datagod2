import { describe, expect, it } from "vitest"
import { homeServiceLinks } from "./home-links"
import { FALLBACK_FACTS, type LiveFacts } from "./live-facts"
import type { ProductKey } from "./products"

function factsWith(on: ProductKey[]): LiveFacts {
  const products = { ...FALLBACK_FACTS.products }
  for (const k of Object.keys(products) as ProductKey[]) {
    products[k] = { ...products[k], available: on.includes(k) }
  }
  return { ...FALLBACK_FACTS, products }
}

const ALL_ON: ProductKey[] = [
  "mtn-data", "telecel-data", "at-data", "airtime", "afa-registration", "utility-bills",
  "results-checker", "bulk-sms", "join", "ussd", "whatsapp", "developers",
]

describe("homeServiceLinks", () => {
  it("links every card on the main site when everything is live", () => {
    expect(homeServiceLinks(factsWith(ALL_ON), true)).toEqual({
      data: "/services#data",
      airtime: "/airtime",
      afa: "/afa-registration",
      bills: "/utility-bills",
      results: "/results-checker",
      "results-service": "/results-checker",
      "bulk-sms": "/bulk-sms",
      shops: "/join",
      "sub-agents": "/join",
      developers: "/developers",
      anywhere: "/ussd",
      all: "/services",
    })
  })

  it("links nothing on a custom domain or shop host", () => {
    expect(homeServiceLinks(factsWith(ALL_ON), false)).toEqual({})
  })

  it("drops links to products that are switched off", () => {
    const links = homeServiceLinks(factsWith(["mtn-data", "results-checker", "bulk-sms", "join"]), true)
    expect(links.airtime).toBeUndefined()
    expect(links.afa).toBeUndefined()
    expect(links.bills).toBeUndefined()
    expect(links.developers).toBeUndefined()
    expect(links.anywhere).toBeUndefined()
    expect(links.data).toBe("/services#data")
    expect(links.results).toBe("/results-checker")
    expect(links.all).toBe("/services")
  })

  it("drops the data link when no network has data on", () => {
    expect(homeServiceLinks(factsWith(["airtime"]), true).data).toBeUndefined()
  })

  it("keeps the data link when any one network is on", () => {
    expect(homeServiceLinks(factsWith(["at-data"]), true).data).toBe("/services#data")
  })
})
