import { describe, expect, it } from "vitest"
import { COMPLETED_WAIT_MS, PROCESSING_WAIT_MS } from "../../support-eligibility"
import { bannedHits } from "../banned"
import { checkSiteGuideLimits } from "../guide"
import { SITE_PAGES } from "../pages"
import { searchSite } from "../search"
import type { Audience } from "../types"
import { ARTICLES } from "./index"
import { BUYING_ARTICLES } from "./buying"

const VALID: Audience[] = ["public", "customer", "dealer", "shop_owner", "admin"]
const CUSTOMER: Audience[] = ["public", "customer"]
const GUEST: Audience[] = ["public"]

/** Digits that may appear because a code constant says so (support-eligibility.ts owner rule). */
const ALLOWED_NUMBER_PHRASES = [
  `${COMPLETED_WAIT_MS / 60000} minutes`,
  `${PROCESSING_WAIT_MS / 3600000} hours`,
]

const EXPECTED_IDS = [
  "afa-registration-dashboard",
  "afa-registration-shop",
  "buy-data-dashboard",
  "buy-data-for-someone-else",
  "buy-data-shop-storefront",
  "check-shop-order-status",
  "data-networks-and-numbers",
  "failed-orders-and-refunds",
  "order-slow-or-not-delivered",
  "order-statuses-dashboard",
  "shop-payment-problems",
  "special-bundles",
  "standard-bundles",
]

function pathsIn(text: string): string[] {
  return Array.from(text.matchAll(/\/(?:dashboard|shop|join|auth|services|results-checker|vouchers)[A-Za-z0-9/:_-]*/g)).map((m) =>
    m[0].replace(/[.,;:)]+$/, ""),
  )
}

describe("buying articles: shape", () => {
  it("has the expected set of articles", () => {
    expect(BUYING_ARTICLES.map((a) => a.id).sort()).toEqual(EXPECTED_IDS)
  })

  it("is registered in the shared ARTICLES list", () => {
    for (const a of BUYING_ARTICLES) expect(ARTICLES).toContain(a)
  })

  it("has unique kebab-case ids across ALL articles", () => {
    const ids = ARTICLES.map((a) => a.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
  })

  it("keeps summaries and bodies inside the size limits", () => {
    for (const a of BUYING_ARTICLES) {
      expect(a.summary.length, `${a.id} summary`).toBeLessThanOrEqual(200)
      expect(a.body.length, `${a.id} body`).toBeLessThanOrEqual(2500)
      expect(a.title.length).toBeGreaterThan(0)
      expect(a.keywords.length, `${a.id} keywords`).toBeGreaterThan(2)
    }
  })

  it("uses valid, non-empty audiences and never admin", () => {
    for (const a of BUYING_ARTICLES) {
      expect(a.audiences.length).toBeGreaterThan(0)
      for (const x of a.audiences) expect(VALID).toContain(x)
      expect(a.audiences, a.id).not.toContain("admin")
    }
  })

  it("answers where / how / what next / what if it goes wrong", () => {
    for (const a of BUYING_ARTICLES) {
      expect(a.body, `${a.id} where`).toMatch(/Where:/)
      expect(a.body, `${a.id} how`).toMatch(/How:[\s\S]*\n1\. /)
      expect(a.body, `${a.id} next`).toMatch(/What happens next:/)
      expect(a.body, `${a.id} wrong`).toMatch(/If something goes wrong:/)
    }
  })

  it("keeps the whole guide inside its budget", () => {
    expect(checkSiteGuideLimits(SITE_PAGES, ARTICLES)).toEqual([])
  })
})

describe("buying articles: content rules", () => {
  it("contains no banned words (suppliers, risk words) anywhere", () => {
    for (const a of BUYING_ARTICLES) {
      const all = [a.title, a.summary, a.body, ...a.keywords].join("\n")
      expect(bannedHits(all), a.id).toEqual([])
    }
  })

  it("has no digits (prices, fees, limits, times) except code-defined constants", () => {
    for (const a of BUYING_ARTICLES) {
      let text = [a.title, a.summary, a.body, ...a.keywords].join("\n")
      for (const p of ALLOWED_NUMBER_PHRASES) text = text.split(p).join("")
      text = text.replace(/^\d+\. /gm, "")
      expect(text, a.id).not.toMatch(/\d/)
    }
  })

  it("names at least one real page path, and only paths that exist", () => {
    const known = new Set(SITE_PAGES.map((p) => p.path))
    for (const a of BUYING_ARTICLES) {
      const paths = pathsIn(a.body)
      expect(paths.length, `${a.id} has a page path`).toBeGreaterThan(0)
      for (const p of paths) expect(known.has(p), `${a.id}: ${p}`).toBe(true)
    }
  })

  it("never sends public-only articles to pages guests cannot open", () => {
    const byPath = new Map(SITE_PAGES.map((p) => [p.path, p]))
    for (const a of BUYING_ARTICLES.filter((x) => !x.audiences.includes("customer"))) {
      for (const p of pathsIn(a.body)) {
        expect(byPath.get(p)!.audiences, `${a.id}: ${p}`).toContain("public")
      }
    }
  })

  it("uses the exact page titles for the pages it names", () => {
    const dash = BUYING_ARTICLES.find((a) => a.id === "buy-data-dashboard")!
    expect(dash.body).toContain("Data packages")
    expect(dash.body).toContain("/dashboard/data-packages")
    const afa = BUYING_ARTICLES.find((a) => a.id === "afa-registration-dashboard")!
    expect(afa.body).toContain("AFA orders")
  })

  it("flags switched-off features as maybe unavailable", () => {
    const special = BUYING_ARTICLES.find((a) => a.id === "special-bundles")!
    expect(special.body).toMatch(/may not be available on your account yet/)
    const std = BUYING_ARTICLES.find((a) => a.id === "standard-bundles")!
    expect(std.body).toMatch(/may not be available on your account yet/)
  })

  it("covers every order status the orders page filters on", () => {
    const a = BUYING_ARTICLES.find((x) => x.id === "order-statuses-dashboard")!
    for (const s of ["Pending", "Processing", "Completed", "Failed", "Reversed", "Activating number"]) {
      expect(a.body, s).toContain(s)
    }
  })

  it("gives the complaint waits only as the code constants", () => {
    const a = BUYING_ARTICLES.find((x) => x.id === "order-slow-or-not-delivered")!
    expect(a.body).toContain(`${COMPLETED_WAIT_MS / 60000} minutes`)
    expect(a.body).toContain(`${PROCESSING_WAIT_MS / 3600000} hours`)
  })

  it("does not promise automatic refunds it cannot prove", () => {
    const a = BUYING_ARTICLES.find((x) => x.id === "failed-orders-and-refunds")!
    expect(a.body).not.toMatch(/automatically refund|always refund|guaranteed/i)
    expect(a.body).toMatch(/Support chat/)
  })
})

describe("buying articles: customers find them with real questions", () => {
  const cases: { q: string; aud: Audience[]; id: string }[] = [
    { q: "how i go buy data for my friend", aud: GUEST, id: "buy-data-for-someone-else" },
    { q: "how do I buy data from my wallet", aud: CUSTOMER, id: "buy-data-dashboard" },
    { q: "buy data from a shop without an account", aud: GUEST, id: "buy-data-shop-storefront" },
    { q: "the momo prompt did not come", aud: GUEST, id: "shop-payment-problems" },
    { q: "which networks can I buy and why is my number rejected", aud: GUEST, id: "data-networks-and-numbers" },
    { q: "what are standard bundles", aud: CUSTOMER, id: "standard-bundles" },
    { q: "special bundle part delivered", aud: CUSTOMER, id: "special-bundles" },
    { q: "what does reversed or activating number mean on my order", aud: CUSTOMER, id: "order-statuses-dashboard" },
    { q: "how do I track my order from a shop with my phone number", aud: GUEST, id: "check-shop-order-status" },
    { q: "my data has not come, it is still processing", aud: GUEST, id: "order-slow-or-not-delivered" },
    { q: "my order failed where is my money", aud: CUSTOMER, id: "failed-orders-and-refunds" },
    { q: "how do I register for AFA with my wallet", aud: CUSTOMER, id: "afa-registration-dashboard" },
    { q: "register AFA through a shop ghana card", aud: GUEST, id: "afa-registration-shop" },
  ]
  for (const c of cases) {
    it(`"${c.q}" finds ${c.id}`, () => {
      const top = searchSite(c.q, c.aud, 3).map((a) => a.id)
      expect(top).toContain(c.id)
    })
  }

  it("hides customer-only articles from guests", () => {
    const guestIds = searchSite("buy data wallet standard special afa order failed", GUEST, 20).map((a) => a.id)
    for (const a of BUYING_ARTICLES.filter((x) => !x.audiences.includes("public"))) {
      expect(guestIds).not.toContain(a.id)
    }
  })
})
