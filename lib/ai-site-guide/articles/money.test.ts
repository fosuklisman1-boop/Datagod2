import { describe, expect, it } from "vitest"
import { bannedHits } from "../banned"
import { checkSiteGuideLimits } from "../guide"
import { SITE_PAGES } from "../pages"
import { searchSite } from "../search"
import type { Audience } from "../types"
import { ARTICLES } from "./index"
import { MONEY_ARTICLES } from "./money"

const VALID: Audience[] = ["public", "customer", "dealer", "shop_owner", "admin"]
const CUSTOMER: Audience[] = ["public", "customer"]
const SHOP: Audience[] = ["public", "customer", "shop_owner"]
const GUEST: Audience[] = ["public"]

const EXPECTED_IDS = [
  "cashback-instant-discount",
  "dealer-upgrade-subscription",
  "pay-from-wallet",
  "refunds-where-to-see-them",
  "send-and-claim",
  "transaction-history",
  "wallet-top-up",
  "wallet-top-up-not-credited",
  "withdraw-shop-profit",
]

function pathsIn(text: string): string[] {
  return Array.from(text.matchAll(/\/(?:dashboard|shop|join|auth|services|results-checker|vouchers)[A-Za-z0-9/:_-]*/g)).map((m) =>
    m[0].replace(/[.,;:)]+$/, ""),
  )
}

const byId = (id: string) => MONEY_ARTICLES.find((a) => a.id === id)!

describe("money articles: shape", () => {
  it("has the expected set of articles", () => {
    expect(MONEY_ARTICLES.map((a) => a.id).sort()).toEqual(EXPECTED_IDS)
  })

  it("is registered in the shared ARTICLES list", () => {
    for (const a of MONEY_ARTICLES) expect(ARTICLES).toContain(a)
  })

  it("has unique kebab-case ids across ALL articles", () => {
    const ids = ARTICLES.map((a) => a.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
  })

  it("keeps summaries and bodies inside the size limits", () => {
    for (const a of MONEY_ARTICLES) {
      expect(a.summary.length, `${a.id} summary`).toBeLessThanOrEqual(200)
      expect(a.body.length, `${a.id} body`).toBeLessThanOrEqual(2500)
      expect(a.title.length).toBeGreaterThan(0)
      expect(a.keywords.length, `${a.id} keywords`).toBeGreaterThan(2)
    }
  })

  it("uses valid, non-empty audiences and never admin", () => {
    for (const a of MONEY_ARTICLES) {
      expect(a.audiences.length).toBeGreaterThan(0)
      for (const x of a.audiences) expect(VALID).toContain(x)
      expect(a.audiences, a.id).not.toContain("admin")
    }
  })

  it("answers where / how / what next / what if it goes wrong", () => {
    for (const a of MONEY_ARTICLES) {
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

describe("money articles: content rules", () => {
  it("contains no banned words anywhere", () => {
    for (const a of MONEY_ARTICLES) {
      const all = [a.title, a.summary, a.body, ...a.keywords].join("\n")
      expect(bannedHits(all), a.id).toEqual([])
    }
  })

  it("has no digits (prices, fees, limits, times) at all", () => {
    for (const a of MONEY_ARTICLES) {
      const text = [a.title, a.summary, a.body, ...a.keywords].join("\n").replace(/^\d+\. /gm, "")
      expect(text, a.id).not.toMatch(/\d/)
    }
  })

  it("names at least one real page path, and only paths that exist", () => {
    const known = new Set(SITE_PAGES.map((p) => p.path))
    for (const a of MONEY_ARTICLES) {
      const paths = pathsIn(a.body)
      expect(paths.length, `${a.id} has a page path`).toBeGreaterThan(0)
      for (const p of paths) expect(known.has(p), `${a.id}: ${p}`).toBe(true)
    }
  })

  it("only sends an article to pages its audience may open", () => {
    const byPath = new Map(SITE_PAGES.map((p) => [p.path, p]))
    for (const a of MONEY_ARTICLES) {
      for (const p of pathsIn(a.body)) {
        const pageAud = byPath.get(p)!.audiences
        // A shop-owner-only page may only be named by an article that reaches shop owners.
        if (pageAud.every((x) => x === "shop_owner")) expect(a.audiences, `${a.id}: ${p}`).toContain("shop_owner")
      }
    }
  })

  it("uses the exact page titles for the pages it names", () => {
    expect(byId("wallet-top-up").body).toContain("Wallet (/dashboard/wallet)")
    expect(byId("transaction-history").body).toContain("Transactions (/dashboard/transactions)")
    expect(byId("withdraw-shop-profit").body).toContain("Withdraw profit (/dashboard/shop-withdraw)")
    expect(byId("dealer-upgrade-subscription").body).toContain("Upgrade to dealer (/dashboard/upgrade)")
  })

  it("says top-up and Send and Claim may be unavailable", () => {
    expect(byId("wallet-top-up").body).toMatch(/may not be available on your account/)
    expect(byId("send-and-claim").body).toMatch(/may not be available on your account yet/)
    expect(byId("dealer-upgrade-subscription").body).toMatch(/paused/i)
  })

  it("describes only buttons and tabs the code really shows", () => {
    const topup = byId("wallet-top-up").body
    expect(topup).toContain("Top Up Wallet")
    expect(byId("wallet-top-up-not-credited").body).toContain("Verify Payment")
    expect(byId("wallet-top-up-not-credited").body).toContain("Pending Payments")
    const sc = byId("send-and-claim").body
    expect(sc).toContain("Generate Payment Details")
    expect(sc).toContain("Sent money but not credited?")
    const wd = byId("withdraw-shop-profit").body
    expect(wd).toContain("Submit Withdrawal Request")
    expect(wd).toContain("Verify Manually")
    const up = byId("dealer-upgrade-subscription").body
    expect(up).toContain("Upgrade Now")
    expect(up).toContain("Renew / Extend")
    expect(up).toContain("View Price List")
  })

  it("never invents a transaction search box (the page has category tabs only)", () => {
    const a = byId("transaction-history")
    expect(a.body).not.toMatch(/search box|search field|search bar/i)
    for (const tab of ["Stats", "Top Ups", "Data", "Results Checker", "Airtime", "AFA", "Misc"]) {
      expect(a.body, tab).toContain(tab)
    }
  })

  it("does not promise automatic refunds, fees, or prices", () => {
    const refund = byId("refunds-where-to-see-them").body
    expect(refund).not.toMatch(/automatically refund|always refund|guaranteed|within minutes/i)
    expect(refund).toMatch(/Support chat/)
    // "Amount (GHS)" is the real label of the amount box; every other currency or percent mention is a quoted figure.
    for (const a of MONEY_ARTICLES) expect(a.body.split("Amount (GHS)").join(""), a.id).not.toMatch(/GHS|GH₵|cedis|%|percent/i)
  })

  it("restricts withdrawals to shop owners and says wallet money cannot be withdrawn there", () => {
    const wd = byId("withdraw-shop-profit")
    expect(wd.audiences).toEqual(["shop_owner"])
    expect(wd.body).toMatch(/shown on the page/)
    expect(wd.body).toMatch(/Wallet page has no withdraw/)
  })

  it("describes cashback as a lower price at checkout, not a separate payout", () => {
    const a = byId("cashback-instant-discount")
    expect(a.body).toMatch(/You pay/)
    expect(a.body).toMatch(/was/)
    expect(a.body).toMatch(/may not apply/i)
  })
})

describe("money articles: customers find them with real questions", () => {
  const cases: { q: string; aud: Audience[]; id: string }[] = [
    { q: "how do I add money to my wallet", aud: CUSTOMER, id: "wallet-top-up" },
    { q: "top up wallet with momo", aud: CUSTOMER, id: "wallet-top-up" },
    { q: "i paid for top up but my wallet no show money", aud: CUSTOMER, id: "wallet-top-up-not-credited" },
    { q: "pending payment verify wallet not credited", aud: CUSTOMER, id: "wallet-top-up-not-credited" },
    { q: "how do I pay for data from my wallet insufficient balance", aud: CUSTOMER, id: "pay-from-wallet" },
    { q: "what is send and claim", aud: CUSTOMER, id: "send-and-claim" },
    { q: "sent money but not credited transaction id reference code", aud: CUSTOMER, id: "send-and-claim" },
    { q: "how do I withdraw my shop profit to momo", aud: SHOP, id: "withdraw-shop-profit" },
    { q: "withdrawal pending how long will it take", aud: SHOP, id: "withdraw-shop-profit" },
    { q: "how i go get my money back refund", aud: CUSTOMER, id: "refunds-where-to-see-them" },
    { q: "was my order refunded to my wallet", aud: CUSTOMER, id: "refunds-where-to-see-them" },
    { q: "what is cashback on airtime", aud: CUSTOMER, id: "cashback-instant-discount" },
    { q: "how do I become a dealer and pay for upgrade", aud: CUSTOMER, id: "dealer-upgrade-subscription" },
    { q: "my dealer subscription is expiring renew", aud: CUSTOMER, id: "dealer-upgrade-subscription" },
    { q: "where can I see all my payments and transactions history", aud: CUSTOMER, id: "transaction-history" },
  ]
  for (const c of cases) {
    it(`"${c.q}" finds ${c.id}`, () => {
      const top = searchSite(c.q, c.aud, 3).map((a) => a.id)
      expect(top).toContain(c.id)
    })
  }

  it("hides signed-in-only articles from guests", () => {
    const guestIds = searchSite("wallet top up withdraw refund cashback upgrade transactions send and claim", GUEST, 30).map((a) => a.id)
    for (const a of MONEY_ARTICLES.filter((x) => !x.audiences.includes("public"))) {
      expect(guestIds).not.toContain(a.id)
    }
  })

  it("hides the withdrawal article from customers who own no shop", () => {
    const ids = searchSite("withdraw shop profit to momo", CUSTOMER, 30).map((a) => a.id)
    expect(ids).not.toContain("withdraw-shop-profit")
  })
})
