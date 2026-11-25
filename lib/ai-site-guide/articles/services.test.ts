import { describe, expect, it } from "vitest"
import { bannedHits } from "../banned"
import { checkSiteGuideLimits } from "../guide"
import { SITE_PAGES } from "../pages"
import { searchSite } from "../search"
import type { Audience } from "../types"
import { ARTICLES } from "./index"
import { SERVICES_ARTICLES } from "./services"

const VALID: Audience[] = ["public", "customer", "dealer", "shop_owner", "admin"]
const CUSTOMER: Audience[] = ["public", "customer"]
const SHOP: Audience[] = ["public", "customer", "shop_owner"]
const GUEST: Audience[] = ["public"]

const EXPECTED_IDS = [
  "buy-airtime-dashboard",
  "buy-airtime-shop-storefront",
  "check-results-service",
  "pay-utility-bills",
  "results-checker-buy-vouchers",
  "results-checker-retrieve-pin",
  "sms-business-sender-id",
  "sms-credits-and-activation",
  "sms-send-bulk",
  "ussd-main-menu",
  "whatsapp-main-bot",
]

function pathsIn(text: string): string[] {
  return Array.from(text.matchAll(/\/(?:dashboard|shop|join|auth|services|results-checker|vouchers|whatsapp|bulk-sms)[A-Za-z0-9/:_-]*/g)).map((m) =>
    m[0].replace(/[.,;:)]+$/, ""),
  )
}

const byId = (id: string) => SERVICES_ARTICLES.find((a) => a.id === id)!

describe("services articles: shape", () => {
  it("has the expected set of articles", () => {
    expect(SERVICES_ARTICLES.map((a) => a.id).sort()).toEqual(EXPECTED_IDS)
  })

  it("is registered in the shared ARTICLES list", () => {
    for (const a of SERVICES_ARTICLES) expect(ARTICLES).toContain(a)
  })

  it("has unique kebab-case ids across ALL articles", () => {
    const ids = ARTICLES.map((a) => a.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
  })

  it("keeps summaries and bodies inside the size limits", () => {
    for (const a of SERVICES_ARTICLES) {
      expect(a.summary.length, `${a.id} summary`).toBeLessThanOrEqual(200)
      expect(a.body.length, `${a.id} body`).toBeLessThanOrEqual(2500)
      expect(a.title.length).toBeGreaterThan(0)
      expect(a.keywords.length, `${a.id} keywords`).toBeGreaterThan(2)
    }
  })

  it("uses valid, non-empty audiences and never admin", () => {
    for (const a of SERVICES_ARTICLES) {
      expect(a.audiences.length).toBeGreaterThan(0)
      for (const x of a.audiences) expect(VALID).toContain(x)
      expect(a.audiences, a.id).not.toContain("admin")
    }
  })

  it("answers where / how / what next / what if it goes wrong", () => {
    for (const a of SERVICES_ARTICLES) {
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

describe("services articles: content rules", () => {
  it("contains no banned words anywhere", () => {
    for (const a of SERVICES_ARTICLES) {
      const all = [a.title, a.summary, a.body, ...a.keywords].join("\n")
      expect(bannedHits(all), a.id).toEqual([])
    }
  })

  it("has no digits (prices, fees, limits, times, dial codes) at all", () => {
    for (const a of SERVICES_ARTICLES) {
      const text = [a.title, a.summary, a.body, ...a.keywords].join("\n").replace(/^\d+\. /gm, "")
      expect(text, a.id).not.toMatch(/\d/)
    }
  })

  it("quotes no amounts, currency or percentages", () => {
    for (const a of SERVICES_ARTICLES) expect([a.body, a.summary].join("\n"), a.id).not.toMatch(/GHS|GH₵|cedis|%|percent/i)
  })

  it("names at least one real page path, and only paths that exist", () => {
    const known = new Set(SITE_PAGES.map((p) => p.path))
    for (const a of SERVICES_ARTICLES) {
      const paths = pathsIn(a.body)
      expect(paths.length, `${a.id} has a page path`).toBeGreaterThan(0)
      for (const p of paths) expect(known.has(p), `${a.id}: ${p}`).toBe(true)
    }
  })

  it("only names shop-owner-only pages in articles that reach shop owners", () => {
    const byPath = new Map(SITE_PAGES.map((p) => [p.path, p]))
    for (const a of SERVICES_ARTICLES) {
      for (const p of pathsIn(a.body)) {
        const pageAud = byPath.get(p)!.audiences
        if (pageAud.every((x) => x === "shop_owner")) expect(a.audiences, `${a.id}: ${p}`).toContain("shop_owner")
      }
    }
  })

  it("never sends a public article to a signed-in-only page without saying an account is needed", () => {
    const byPath = new Map(SITE_PAGES.map((p) => [p.path, p]))
    for (const a of SERVICES_ARTICLES.filter((x) => x.audiences.includes("public"))) {
      const signedIn = pathsIn(a.body).filter((p) => !byPath.get(p)!.audiences.includes("public"))
      if (signedIn.length) expect(a.body, a.id).toMatch(/log in|logged in|signed in|account/i)
    }
  })

  it("uses the exact page titles for the pages it names", () => {
    expect(byId("buy-airtime-dashboard").body).toContain("Buy airtime (/dashboard/airtime)")
    expect(byId("buy-airtime-shop-storefront").body).toContain("Shop airtime (/shop/:slug/airtime)")
    expect(byId("pay-utility-bills").body).toContain("Utility bills (/dashboard/bills)")
    expect(byId("pay-utility-bills").body).toContain("Telecel broadband (/dashboard/broadband)")
    expect(byId("results-checker-buy-vouchers").body).toContain("Results checker (/dashboard/results-checker)")
    expect(byId("results-checker-buy-vouchers").body).toContain("Results checker (/results-checker)")
    expect(byId("results-checker-retrieve-pin").body).toContain("Retrieve vouchers (/vouchers)")
    expect(byId("check-results-service").body).toContain("Check results (/dashboard/results-check)")
    expect(byId("ussd-main-menu").body).toContain("Services (/services)")
    expect(byId("sms-send-bulk").body).toContain("Send SMS (/dashboard/sms/compose)")
    expect(byId("sms-send-bulk").body).toContain("Bulk SMS (/bulk-sms)")
    expect(byId("sms-credits-and-activation").body).toContain("SMS credits (/dashboard/sms/credits)")
    expect(byId("sms-credits-and-activation").body).toContain("SMS home (/dashboard/sms)")
    expect(byId("sms-business-sender-id").body).toContain("Business SMS (/dashboard/sms/business)")
    expect(byId("whatsapp-main-bot").body).toContain("WhatsApp ordering (/whatsapp)")
  })

  it("describes only buttons, tabs and labels the code really shows", () => {
    const air = byId("buy-airtime-dashboard").body
    for (const label of ["Beneficiary phone number", "Quick amount", "Custom amount", "Proceed to payment", "History", "Pay processing fee separately"]) {
      expect(air, label).toContain(label)
    }
    const shopAir = byId("buy-airtime-shop-storefront").body
    for (const label of ["Beneficiary Number", "Mobile Money number to pay from", "Send verification code", "Proceed to payment"]) {
      expect(shopAir, label).toContain(label)
    }
    const bills = byId("pay-utility-bills").body
    for (const label of ["Pay a bill", "Saved meters", "Find my meters", "Verify account", "Save for next time", "Recent payments", "Ghana Water", "DSTV", "GOtv", "StarTimes TV"]) {
      expect(bills, label).toContain(label)
    }
    const buy = byId("results-checker-buy-vouchers").body
    for (const label of ["Buy Vouchers", "History", "Exam Board", "Quantity", "Resend SMS", "Resend Email", "Download receipt"]) {
      expect(buy, label).toContain(label)
    }
    const find = byId("results-checker-retrieve-pin").body
    for (const label of ["By Phone Number", "By Reference", "Resend SMS", "Find your order"]) expect(find, label).toContain(label)
    const check = byId("check-results-service").body
    for (const label of ["School Candidate", "Private Candidate", "Index Number", "Date of Birth", "Customer has their own voucher", "We supply the voucher"]) {
      expect(check, label).toContain(label)
    }
    const ussd = byId("ussd-main-menu").body
    for (const label of ["Browse Services", "AFA Registration", "Buy Airtime", "Results Checker", "Datagod Wallet", "MoMo prompt"]) {
      expect(ussd, label).toContain(label)
    }
    const sms = byId("sms-send-bulk").body
    for (const label of ["Paste", "Groups", "My customers", "CSV", "Save as template", "Send later", "Send SMS"]) expect(sms, label).toContain(label)
    const credits = byId("sms-credits-and-activation").body
    for (const label of ["Unlock Customer SMS", "Buy", "Recent Credit Activity"]) expect(credits, label).toContain(label)
    const biz = byId("sms-business-sender-id").body
    for (const label of ["Verify your business", "Business name", "Ghana Card number", "Save draft", "Submit for review", "Request a sender ID", "Your Sender ID"]) {
      expect(biz, label).toContain(label)
    }
    const wa = byId("whatsapp-main-bot").body
    for (const label of ["Chat on WhatsApp", "Pay via Wallet", "Pay via MoMo"]) expect(wa, label).toContain(label)
  })

  it("points to other articles instead of repeating them", () => {
    expect(byId("buy-airtime-dashboard").body).toContain("pay-from-wallet")
    expect(byId("buy-airtime-dashboard").body).toContain("cashback-instant-discount")
    expect(byId("sms-send-bulk").body).toContain("shop-sms-customers")
    expect(byId("whatsapp-main-bot").body).toContain("whatsapp-shop-bot")
    expect(byId("ussd-main-menu").body).toContain("ussd-buy-from-a-shop")
  })

  it("says dark or switchable features may not be available yet", () => {
    for (const id of ["pay-utility-bills", "ussd-main-menu", "whatsapp-main-bot", "check-results-service"]) {
      expect(byId(id).body, id).toMatch(/may not be available/)
    }
    expect(byId("sms-business-sender-id").body).toMatch(/may not be available/)
  })

  it("says fees, prices and dial codes are shown on the page, never quoted", () => {
    expect(byId("buy-airtime-dashboard").body).toMatch(/fee is shown on the page|shown on the page/)
    expect(byId("ussd-main-menu").body).toMatch(/shown on the (Datagod )?(website|site)/)
    expect(byId("sms-credits-and-activation").body).toMatch(/shown on the page/)
    expect(byId("results-checker-buy-vouchers").body).toMatch(/shown on the page/)
  })

  it("never says where PINs are stored or how they are protected", () => {
    for (const a of SERVICES_ARTICLES) {
      expect(a.body, a.id).not.toMatch(/encrypt|hash|database|stored|storage|vault|supplier|stock level/i)
    }
  })

  it("never reveals rule shapes or internal workings", () => {
    for (const a of ARTICLES.filter((x) => !x.audiences.includes("admin"))) {
      expect([a.title, a.summary, a.body, ...a.keywords].join("\n"), a.id).not.toMatch(
        /first withdrawal|between withdrawals|cooling|waiting period|held for review|sent by hand|admins? reserve|reject them later|clawback|cap of|price is too low|wrong tries|few tries|at most|at least \w+ (?:orders|days|hours)|per send|daily limit|scam|link rules|policy engine|auto-split|batches|opt-out/i,
      )
    }
  })

  it("does not use data or bundle wording in the USSD article", () => {
    const a = byId("ussd-main-menu")
    expect([a.title, a.summary, a.body].join("\n")).not.toMatch(/\bdata\b|bundle/i)
  })

  it("keeps the articles away from audiences that cannot use the pages", () => {
    expect(byId("buy-airtime-dashboard").audiences).toEqual(["customer"])
    expect(byId("buy-airtime-shop-storefront").audiences).toEqual(["public"])
    expect(byId("pay-utility-bills").audiences).toEqual(["customer"])
    expect(byId("results-checker-buy-vouchers").audiences).toEqual(["public", "customer"])
    expect(byId("results-checker-retrieve-pin").audiences).toEqual(["public", "customer"])
    expect(byId("check-results-service").audiences).toEqual(["public", "customer"])
    expect(byId("ussd-main-menu").audiences).toEqual(["public"])
    expect(byId("whatsapp-main-bot").audiences).toEqual(["public"])
    for (const id of ["sms-credits-and-activation", "sms-business-sender-id"]) expect(byId(id).audiences).toEqual(["customer", "shop_owner"])
    expect(byId("sms-send-bulk").audiences).toEqual(["public", "customer", "shop_owner"])
  })

  it("always asks for a MoMo number on WhatsApp and never uses the chat number to pay", () => {
    const a = byId("whatsapp-main-bot")
    expect(a.body).toMatch(/always asks (you )?for the Mobile Money number|always asks for a Mobile Money number/i)
    expect(a.body).toMatch(/never (charges|uses) the number you are chatting from|chat number/i)
  })

  it("tells people to keep PINs private", () => {
    expect(byId("results-checker-buy-vouchers").body).toMatch(/Keep (your )?PINs? private|do not share/i)
  })
})

describe("services articles: people find them with real questions", () => {
  const cases: { q: string; aud: Audience[]; id: string }[] = [
    { q: "how do I buy airtime", aud: CUSTOMER, id: "buy-airtime-dashboard" },
    { q: "i want to recharge my friend airtime from my wallet", aud: CUSTOMER, id: "buy-airtime-dashboard" },
    { q: "airtime service fee pay processing fee separately", aud: CUSTOMER, id: "buy-airtime-dashboard" },
    { q: "can i buy airtime from a shop without account", aud: GUEST, id: "buy-airtime-shop-storefront" },
    { q: "how i go buy airtime on shop link with momo", aud: GUEST, id: "buy-airtime-shop-storefront" },
    { q: "how do I pay my ECG electricity bill", aud: CUSTOMER, id: "pay-utility-bills" },
    { q: "pay dstv gotv startimes water bill", aud: CUSTOMER, id: "pay-utility-bills" },
    { q: "telecel broadband renew", aud: CUSTOMER, id: "pay-utility-bills" },
    { q: "how do I buy a WASSCE results checker voucher", aud: CUSTOMER, id: "results-checker-buy-vouchers" },
    { q: "where is my results checker pin and serial number", aud: CUSTOMER, id: "results-checker-buy-vouchers" },
    { q: "i lost my bece checker pin resend it", aud: GUEST, id: "results-checker-retrieve-pin" },
    { q: "retrieve voucher by reference or phone number", aud: GUEST, id: "results-checker-retrieve-pin" },
    { q: "i dont have a voucher can you check my results for me", aud: CUSTOMER, id: "check-results-service" },
    { q: "check results service index number whatsapp delivery", aud: GUEST, id: "check-results-service" },
    { q: "how do I use the ussd code to buy", aud: GUEST, id: "ussd-main-menu" },
    { q: "buy without internet browse services dial code", aud: GUEST, id: "ussd-main-menu" },
    { q: "how do I send bulk sms to my contacts", aud: CUSTOMER, id: "sms-send-bulk" },
    { q: "send sms campaign to my customers", aud: GUEST, id: "sms-send-bulk" },
    { q: "how do I buy sms credits", aud: SHOP, id: "sms-credits-and-activation" },
    { q: "unlock customer sms activate", aud: CUSTOMER, id: "sms-credits-and-activation" },
    { q: "how do i get my own sender id business name", aud: SHOP, id: "sms-business-sender-id" },
    { q: "verify my business kyc ghana card for sms", aud: CUSTOMER, id: "sms-business-sender-id" },
    { q: "can i order data on whatsapp", aud: GUEST, id: "whatsapp-main-bot" },
    { q: "how to buy airtime by whatsapp chat bot", aud: GUEST, id: "whatsapp-main-bot" },
  ]
  for (const c of cases) {
    it(`"${c.q}" finds ${c.id}`, () => {
      const top = searchSite(c.q, c.aud, 3).map((a) => a.id)
      expect(top).toContain(c.id)
    })
  }

  it("hides signed-in-only articles from guests", () => {
    const guestIds = searchSite("airtime utility bills ecg sms credits sender id business verification vouchers", GUEST, 60).map((a) => a.id)
    for (const a of SERVICES_ARTICLES.filter((x) => !x.audiences.includes("public"))) {
      expect(guestIds).not.toContain(a.id)
    }
  })
})
