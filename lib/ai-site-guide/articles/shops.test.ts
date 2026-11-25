import { describe, expect, it } from "vitest"
import { bannedHits } from "../banned"
import { checkSiteGuideLimits } from "../guide"
import { SITE_PAGES } from "../pages"
import { searchSite } from "../search"
import type { Audience } from "../types"
import { ARTICLES } from "./index"
import { SHOP_ARTICLES } from "./shops"

const VALID: Audience[] = ["public", "customer", "dealer", "shop_owner", "admin"]
const CUSTOMER: Audience[] = ["public", "customer"]
const SHOP: Audience[] = ["public", "customer", "shop_owner"]
const GUEST: Audience[] = ["public"]

const EXPECTED_IDS = [
  "become-a-dealer-or-agent",
  "create-your-shop",
  "share-your-shop-link",
  "shop-blocked-numbers",
  "shop-customers-list",
  "shop-pricing-and-profit",
  "shop-sms-customers",
  "sub-agent-buy-stock",
  "sub-agent-join-a-shop",
  "sub-agents-manage",
  "text-to-buy-customer",
  "text-to-buy-shop",
  "text-to-buy-shop-line",
  "ussd-buy-from-a-shop",
  "ussd-shop-setup",
  "whatsapp-shop-bot",
]

function pathsIn(text: string): string[] {
  return Array.from(text.matchAll(/\/(?:dashboard|shop|join|auth|services|results-checker|vouchers)[A-Za-z0-9/:_-]*/g)).map((m) =>
    m[0].replace(/[.,;:)]+$/, ""),
  )
}

const byId = (id: string) => SHOP_ARTICLES.find((a) => a.id === id)!

describe("shops articles: shape", () => {
  it("has the expected set of articles", () => {
    expect(SHOP_ARTICLES.map((a) => a.id).sort()).toEqual(EXPECTED_IDS)
  })

  it("is registered in the shared ARTICLES list", () => {
    for (const a of SHOP_ARTICLES) expect(ARTICLES).toContain(a)
  })

  it("has unique kebab-case ids across ALL articles", () => {
    const ids = ARTICLES.map((a) => a.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
  })

  it("keeps summaries and bodies inside the size limits", () => {
    for (const a of SHOP_ARTICLES) {
      expect(a.summary.length, `${a.id} summary`).toBeLessThanOrEqual(200)
      expect(a.body.length, `${a.id} body`).toBeLessThanOrEqual(2500)
      expect(a.title.length).toBeGreaterThan(0)
      expect(a.keywords.length, `${a.id} keywords`).toBeGreaterThan(2)
    }
  })

  it("uses valid, non-empty audiences and never admin", () => {
    for (const a of SHOP_ARTICLES) {
      expect(a.audiences.length).toBeGreaterThan(0)
      for (const x of a.audiences) expect(VALID).toContain(x)
      expect(a.audiences, a.id).not.toContain("admin")
    }
  })

  it("answers where / how / what next / what if it goes wrong", () => {
    for (const a of SHOP_ARTICLES) {
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

describe("shops articles: content rules", () => {
  it("contains no banned words anywhere", () => {
    for (const a of SHOP_ARTICLES) {
      const all = [a.title, a.summary, a.body, ...a.keywords].join("\n")
      expect(bannedHits(all), a.id).toEqual([])
    }
  })

  it("has no digits (prices, fees, limits, times, dial codes) at all", () => {
    for (const a of SHOP_ARTICLES) {
      const text = [a.title, a.summary, a.body, ...a.keywords].join("\n").replace(/^\d+\. /gm, "")
      expect(text, a.id).not.toMatch(/\d/)
    }
  })

  it("quotes no amounts, currency or percentages", () => {
    for (const a of SHOP_ARTICLES) expect([a.body, a.summary].join("\n"), a.id).not.toMatch(/GHS|GH₵|cedis|%|percent/i)
  })

  it("names at least one real page path, and only paths that exist", () => {
    const known = new Set(SITE_PAGES.map((p) => p.path))
    for (const a of SHOP_ARTICLES) {
      const paths = pathsIn(a.body)
      expect(paths.length, `${a.id} has a page path`).toBeGreaterThan(0)
      for (const p of paths) expect(known.has(p), `${a.id}: ${p}`).toBe(true)
    }
  })

  it("only names shop-owner-only pages in articles that reach shop owners", () => {
    const byPath = new Map(SITE_PAGES.map((p) => [p.path, p]))
    for (const a of SHOP_ARTICLES) {
      for (const p of pathsIn(a.body)) {
        const pageAud = byPath.get(p)!.audiences
        if (pageAud.every((x) => x === "shop_owner")) expect(a.audiences, `${a.id}: ${p}`).toContain("shop_owner")
      }
    }
  })

  it("never sends a public article to a signed-in-only page", () => {
    const byPath = new Map(SITE_PAGES.map((p) => [p.path, p]))
    for (const a of SHOP_ARTICLES.filter((x) => x.audiences.includes("public"))) {
      const dashboardPaths = pathsIn(a.body).filter((p) => !byPath.get(p)!.audiences.includes("public"))
      // A public article may point at the one signed-in page a would-be dealer needs next, but must say it needs an account.
      if (dashboardPaths.length) expect(a.body, a.id).toMatch(/log in|logged in|signed in|account/i)
    }
  })

  it("uses the exact page titles for the pages it names", () => {
    expect(byId("create-your-shop").body).toContain("My shop (/dashboard/my-shop)")
    expect(byId("shop-pricing-and-profit").body).toContain("Shop pricing (/dashboard/shop-pricing)")
    expect(byId("shop-pricing-and-profit").body).toContain("Profit logs (/dashboard/shop-profit-logs)")
    expect(byId("sub-agents-manage").body).toContain("Sub-agents (/dashboard/sub-agents)")
    expect(byId("sub-agents-manage").body).toContain("Sub-agent catalog (/dashboard/sub-agent-catalog)")
    expect(byId("sub-agent-buy-stock").body).toContain("Buy data (sub-agent) (/dashboard/buy-stock)")
    expect(byId("ussd-shop-setup").body).toContain("USSD / WhatsApp bot (/dashboard/ussd-shop)")
    expect(byId("whatsapp-shop-bot").body).toContain("USSD / WhatsApp bot (/dashboard/ussd-shop)")
    expect(byId("text-to-buy-shop").body).toContain("Text orders (/dashboard/text-orders)")
    expect(byId("shop-customers-list").body).toContain("Shop customers (/dashboard/customers)")
    expect(byId("shop-blocked-numbers").body).toContain("Blocked numbers (/dashboard/blocked-numbers)")
    expect(byId("shop-sms-customers").body).toContain("Send SMS (/dashboard/sms/compose)")
    expect(byId("sub-agent-join-a-shop").body).toContain("Join a shop (/join/shop/:handle)")
    expect(byId("become-a-dealer-or-agent").body).toContain("Become a reseller (/join)")
    expect(byId("become-a-dealer-or-agent").body).toContain("Upgrade to dealer (/dashboard/upgrade)")
  })

  it("describes only buttons, tabs and labels the code really shows", () => {
    expect(byId("create-your-shop").body).toContain("Create Shop")
    expect(byId("create-your-shop").body).toContain("Shop Name")
    expect(byId("create-your-shop").body).toContain("Pending Approval")
    const price = byId("shop-pricing-and-profit").body
    for (const label of ["Data Bundles", "Airtime", "Results Checker", "AFA Registration", "Bulk Pricing", "Save All & Go Live"]) {
      expect(price, label).toContain(label)
    }
    const share = byId("share-your-shop-link").body
    for (const label of ["Copy", "Storefront Notice", "Save Notice", "Share on WhatsApp"]) expect(share, label).toContain(label)
    const sub = byId("sub-agents-manage").body
    for (const label of ["Invite Sub-Agent", "Pending Requests", "Approve", "Decline", "Profit History"]) expect(sub, label).toContain(label)
    const join = byId("sub-agent-join-a-shop").body
    expect(join).toContain("Join Now")
    expect(join).toContain("Apply Now")
    const ussd = byId("ussd-shop-setup").body
    for (const label of ["Your Shop Code", "Activate with Wallet", "USSD Display Name"]) expect(ussd, label).toContain(label)
    const wa = byId("whatsapp-shop-bot").body
    for (const label of ["WhatsApp Bot", "Activate WhatsApp Shop"]) expect(wa, label).toContain(label)
    const cust = byId("shop-customers-list").body
    for (const label of ["Recent", "Top Spenders", "Most Orders"]) expect(cust, label).toContain(label)
    const sms = byId("shop-sms-customers").body
    expect(sms).toContain("My customers")
    expect(sms).toContain("Customer order SMS")
    const blocked = byId("shop-blocked-numbers").body
    for (const label of ["My shops", "Export"]) expect(blocked, label).toContain(label)
  })

  it("points to the money article for withdrawals instead of repeating it", () => {
    expect(byId("shop-pricing-and-profit").body).toContain("withdraw-shop-profit")
    expect(byId("shop-pricing-and-profit").body).not.toMatch(/Submit Withdrawal Request|Verify Manually/)
  })

  it("says dark or switchable features may not be available yet", () => {
    for (const id of ["text-to-buy-shop", "shop-blocked-numbers", "whatsapp-shop-bot", "ussd-shop-setup"]) {
      expect(byId(id).body, id).toMatch(/may not be available on your account yet/)
    }
    expect(byId("sub-agent-join-a-shop").body).toMatch(/may not be open/i)
  })

  it("says fees and prices are shown on the page, never quoted", () => {
    expect(byId("ussd-shop-setup").body).toMatch(/fee is shown on the page/)
    expect(byId("whatsapp-shop-bot").body).toMatch(/fee is shown on the page/)
  })

  it("never reveals rule shapes or internal workings", () => {
    for (const a of ARTICLES.filter((x) => !x.audiences.includes("admin"))) {
      expect([a.title, a.summary, a.body, ...a.keywords].join("\n"), a.id).not.toMatch(
        /first withdrawal|between withdrawals|cooling|waiting period|held for review|sent by hand|admins? reserve|reject them later|clawback|cap of|price is too low|wrong tries|few tries|at most|at least \w+ (?:orders|days|hours)/i,
      )
    }
  })

  it("keeps the shop-owner articles away from customers who own no shop", () => {
    for (const a of SHOP_ARTICLES.filter((x) => x.audiences.length === 1 && x.audiences[0] === "shop_owner")) {
      expect(a.audiences).toEqual(["shop_owner"])
    }
    expect(byId("create-your-shop").audiences).toContain("customer")
    expect(byId("become-a-dealer-or-agent").audiences).toEqual(["public", "customer"])
    expect(byId("sub-agent-join-a-shop").audiences).toEqual(["public", "customer"])
    expect(byId("ussd-buy-from-a-shop").audiences).toEqual(["public"])
  })

  it("explains the customer text-to-buy flow without quoting a number and says it may be unavailable", () => {
    const a = byId("text-to-buy-customer")
    expect(a.audiences).toEqual(["public"])
    expect(a.body).toMatch(/may not be available/)
    expect(a.body).toMatch(/never from a wallet/)
    expect(a.body).toMatch(/shop's own number/)
    expect(a.body).toMatch(/remembered/)
  })

  it("credits sub-agent shares at payment, and uses one buy-stock title", () => {
    expect(byId("sub-agents-manage").body).toMatch(/customer payment goes through/)
    expect(byId("sub-agents-manage").body).not.toMatch(/order completes/)
    expect(byId("sub-agent-join-a-shop").body).toContain("Buy data (sub-agent)")
    expect(byId("sub-agent-join-a-shop").body).not.toContain("Buy Data page")
  })

  it("is honest that text orders and activation depend on the account", () => {
    expect(byId("text-to-buy-shop").body).toMatch(/SMS credits/)
    expect(byId("whatsapp-shop-bot").body).toMatch(/Activation required/)
  })
})

describe("shops articles: people find them with real questions", () => {
  const cases: { q: string; aud: Audience[]; id: string }[] = [
    { q: "how do I become an agent and sell data", aud: CUSTOMER, id: "become-a-dealer-or-agent" },
    { q: "i want to start reselling data how i go join", aud: GUEST, id: "become-a-dealer-or-agent" },
    { q: "how do I create my own shop", aud: CUSTOMER, id: "create-your-shop" },
    { q: "open a storefront to sell data", aud: CUSTOMER, id: "create-your-shop" },
    { q: "how do I set my selling price and profit", aud: SHOP, id: "shop-pricing-and-profit" },
    { q: "when do I get my shop profit", aud: SHOP, id: "shop-pricing-and-profit" },
    { q: "how do I share my shop link with customers", aud: SHOP, id: "share-your-shop-link" },
    { q: "my shop qr code and whatsapp link", aud: SHOP, id: "share-your-shop-link" },
    { q: "how do I invite a sub agent", aud: SHOP, id: "sub-agents-manage" },
    { q: "approve sub agent request and set wholesale catalog", aud: SHOP, id: "sub-agents-manage" },
    { q: "how i go join someone's shop as sub agent", aud: GUEST, id: "sub-agent-join-a-shop" },
    { q: "join now apply now become sub agent under a shop", aud: CUSTOMER, id: "sub-agent-join-a-shop" },
    { q: "i am a sub agent how do I buy data from my parent shop", aud: SHOP, id: "sub-agent-buy-stock" },
    { q: "how do customers buy from my shop on ussd", aud: SHOP, id: "ussd-shop-setup" },
    { q: "activate my ussd shop code", aud: SHOP, id: "ussd-shop-setup" },
    { q: "can i buy data by sms", aud: GUEST, id: "text-to-buy-customer" },
    { q: "how to order data with text message", aud: CUSTOMER, id: "text-to-buy-customer" },
    { q: "how do I buy data from a shop with ussd shop code", aud: GUEST, id: "ussd-buy-from-a-shop" },
    { q: "ussd press 1 last shop helpline", aud: GUEST, id: "ussd-buy-from-a-shop" },
    { q: "activate whatsapp shop bot for my customers", aud: SHOP, id: "whatsapp-shop-bot" },
    { q: "customers order by sms text to buy my shop", aud: SHOP, id: "text-to-buy-shop" },
    { q: "send sms to all my shop customers promo", aud: SHOP, id: "shop-sms-customers" },
    { q: "see my shop customers top spenders", aud: SHOP, id: "shop-customers-list" },
    { q: "blocked numbers my shop customers tried", aud: SHOP, id: "shop-blocked-numbers" },
  ]
  for (const c of cases) {
    it(`"${c.q}" finds ${c.id}`, () => {
      const top = searchSite(c.q, c.aud, 3).map((a) => a.id)
      expect(top).toContain(c.id)
    })
  }

  it("hides signed-in-only articles from guests", () => {
    const guestIds = searchSite("shop pricing profit sub agent catalog customers blocked numbers text orders whatsapp bot", GUEST, 40).map((a) => a.id)
    for (const a of SHOP_ARTICLES.filter((x) => !x.audiences.includes("public"))) {
      expect(guestIds).not.toContain(a.id)
    }
  })

  it("hides shop-owner articles from customers who own no shop", () => {
    const ids = searchSite("shop pricing profit sub agent catalog customers blocked numbers text orders whatsapp bot ussd", CUSTOMER, 40).map((a) => a.id)
    for (const a of SHOP_ARTICLES.filter((x) => x.audiences.length === 1 && x.audiences[0] === "shop_owner")) {
      expect(ids).not.toContain(a.id)
    }
  })
})
