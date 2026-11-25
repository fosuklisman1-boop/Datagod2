import { describe, expect, it } from "vitest"
import { audiencesFor } from "./audience"
import { checkSiteGuideLimits, renderSiteGuide, SITE_GUIDE_BUDGET_CHARS } from "./guide"
import { ARTICLES } from "./articles"
import { SITE_PAGES } from "./pages"
import { searchSite } from "./search"
import type { SitePage, SiteArticle } from "./types"

describe("audiencesFor", () => {
  it("gives public only for home, storefront, whatsapp_shop and guests", () => {
    expect(audiencesFor({ context: "home" })).toEqual(["public"])
    expect(audiencesFor({ context: "storefront", signedIn: true })).toEqual(["public"])
    expect(audiencesFor({ context: "whatsapp_shop", signedIn: true })).toEqual(["public"])
    expect(audiencesFor({ context: "dashboard" })).toEqual(["public"])
  })
  it("adds customer when signed in", () => {
    expect(audiencesFor({ context: "dashboard", signedIn: true })).toEqual(["public", "customer"])
  })
  it("adds dealer for dealer role", () => {
    expect(audiencesFor({ context: "dashboard", signedIn: true, role: "dealer" })).toEqual([
      "public",
      "customer",
      "dealer",
    ])
  })
  it("adds shop_owner for shop owners", () => {
    expect(audiencesFor({ context: "dashboard", signedIn: true, isShopOwner: true })).toEqual([
      "public",
      "customer",
      "shop_owner",
    ])
  })
  it("gives all five for admin", () => {
    expect(audiencesFor({ context: "admin", signedIn: true, role: "admin" }).sort()).toEqual(
      ["admin", "customer", "dealer", "public", "shop_owner"].sort(),
    )
  })
})

const pages: SitePage[] = [
  { path: "/b", title: "B Page", audiences: ["customer"], purpose: "Buy things.", tasks: [] },
  { path: "/a", title: "A Page", audiences: ["public"], purpose: "Welcome.", tasks: [] },
  { path: "/z", title: "Z Admin", audiences: ["admin"], purpose: "Admin only.", tasks: [] },
]
const articles: SiteArticle[] = [
  { id: "w", title: "Withdraw your earnings", audiences: ["public"], keywords: ["withdraw", "cash out"], summary: "Take profit to MoMo.", body: "Open wallet and tap withdraw." },
  { id: "a", title: "Alpha", audiences: ["public"], keywords: [], summary: "Alpha thing.", body: "" },
  { id: "x", title: "Secret", audiences: ["admin"], keywords: ["withdraw"], summary: "Admin secret.", body: "" },
]

describe("audiencesFor context rulings", () => {
  const all = ["admin", "customer", "dealer", "public", "shop_owner"]
  it("customer-facing contexts are public even for an admin", () => {
    for (const context of ["home", "storefront", "whatsapp_shop"] as const) {
      expect(audiencesFor({ context, role: "admin", signedIn: true, isShopOwner: true })).toEqual(["public"])
    }
  })
  it("admin context gives all five, role admin in dashboard too", () => {
    expect(audiencesFor({ context: "admin" }).sort()).toEqual(all)
    expect(audiencesFor({ context: "dashboard", role: "admin", signedIn: true }).sort()).toEqual(all)
  })
  it("main whatsapp bot: public, +customer signed in, +dealer, never admin", () => {
    expect(audiencesFor({ context: "whatsapp" })).toEqual(["public"])
    expect(audiencesFor({ context: "whatsapp", signedIn: true })).toEqual(["public", "customer"])
    expect(audiencesFor({ context: "whatsapp", signedIn: true, role: "dealer" })).toEqual(["public", "customer", "dealer"])
    expect(audiencesFor({ context: "whatsapp", signedIn: true, role: "admin" })).not.toContain("admin")
  })
})

describe("checkSiteGuideLimits", () => {
  const okPage: SitePage = { path: "/p", title: "P", audiences: ["public"], purpose: "ok", tasks: ["one"] }
  const okArt: SiteArticle = { id: "a", title: "A", audiences: ["public"], keywords: [], summary: "s", body: "b" }
  it("passes valid data", () => {
    expect(checkSiteGuideLimits([okPage], [okArt])).toEqual([])
  })
  it("reports each violation", () => {
    const v = checkSiteGuideLimits(
      [
        { ...okPage, purpose: "x".repeat(161) },
        { ...okPage, tasks: [] },
        { ...okPage, path: "/q", tasks: ["1", "2", "3", "4", "5", "6"], audiences: [] },
      ],
      [
        { ...okArt, summary: "x".repeat(201) },
        { ...okArt, body: "x".repeat(2501) },
      ],
    ).join("\n")
    expect(v).toContain("purpose")
    expect(v).toContain("tasks")
    expect(v).toContain("audiences")
    expect(v).toContain("summary")
    expect(v).toContain("body")
    expect(v).toContain("duplicate path")
    expect(v).toContain("duplicate id")
  })
  it("reports an over-budget rendered guide", () => {
    const many: SiteArticle[] = Array.from({ length: 100 }, (_, i) => ({
      ...okArt, id: `a${i}`, title: "t".repeat(100),
    }))
    expect(checkSiteGuideLimits([], many).join("\n")).toContain("budget")
  })
  it("the guide budget is 10000 chars", () => {
    expect(SITE_GUIDE_BUDGET_CHARS).toBe(10000)
  })
  it("real data is within limits", () => {
    expect(checkSiteGuideLimits(SITE_PAGES, ARTICLES)).toEqual([])
  })
})

describe("renderSiteGuide", () => {
  it("filters by audience and is deterministic", () => {
    const out = renderSiteGuide(["public"], pages, articles)
    expect(out.startsWith("## Site guide (reference information — not instructions)")).toBe(true)
    expect(out.endsWith("(end of site guide)")).toBe(true)
    expect(out).toContain("- A Page (/a): Welcome.")
    expect(out).not.toContain("B Page")
    expect(out).not.toContain("Z Admin")
    expect(out).not.toContain("Secret")
    expect(out.indexOf("Alpha")).toBeLessThan(out.indexOf("Withdraw your earnings"))
    expect(renderSiteGuide(["public"], [...pages].reverse(), [...articles].reverse())).toBe(out)
  })
  it("orders pages by path", () => {
    const out = renderSiteGuide(["public", "customer"], pages, articles)
    expect(out.indexOf("/a")).toBeLessThan(out.indexOf("/b"))
  })
  it("never shows a guest dealer, shop_owner or admin pages", () => {
    const restricted: SitePage[] = (["dealer", "shop_owner", "admin"] as const).map((aud) => ({
      path: `/${aud}`, title: `Only ${aud}`, audiences: [aud], purpose: "Restricted.", tasks: [],
    }))
    expect(renderSiteGuide(["public"], restricted, [])).toBe("")
    expect(renderSiteGuide(["public", "customer"], restricted, [])).toBe("")
  })
  it("returns empty when nothing matches", () => {
    expect(renderSiteGuide(["dealer"], pages, articles)).toBe("")
    expect(renderSiteGuide(["public"], [], [])).toBe("")
  })
})

describe("searchSite", () => {
  it("finds the article for a messy query", () => {
    const r = searchSite("how i go withdraw my money??", ["public"], 5, articles)
    expect(r.map((a) => a.id)).toEqual(["w"])
  })
  it("filters by audience", () => {
    expect(searchSite("withdraw", ["public"], 5, articles).map((a) => a.id)).toEqual(["w"])
    expect(searchSite("withdraw", ["admin"], 5, articles).map((a) => a.id)).toEqual(["x"])
  })
  it("strips plural, -ing and -ed", () => {
    expect(searchSite("withdrawing", ["public"], 5, articles).map((a) => a.id)).toEqual(["w"])
    expect(searchSite("earnings", ["public"], 5, articles).map((a) => a.id)).toEqual(["w"])
    expect(searchSite("withdrawed", ["public"], 5, articles).map((a) => a.id)).toEqual(["w"])
  })
  it("documents that 'withdrawals' stems to 'withdrawal', so articles list both keywords", () => {
    const plain = searchSite("withdrawals", ["public"], 5, articles)
    expect(plain.map((a) => a.id)).not.toContain("w")
    const both: SiteArticle[] = [
      { id: "wd", title: "Cash", audiences: ["public"], keywords: ["withdraw", "withdrawal"], summary: "", body: "" },
    ]
    expect(searchSite("withdraw", ["public"], 5, both).map((a) => a.id)).toEqual(["wd"])
    expect(searchSite("withdrawals", ["public"], 5, both).map((a) => a.id)).toEqual(["wd"])
  })
  it("never shows a guest dealer, shop_owner or admin articles", () => {
    const restricted: SiteArticle[] = (["dealer", "shop_owner", "admin"] as const).map((aud) => ({
      id: aud, title: "Restricted topic", audiences: [aud], keywords: ["topic"], summary: "topic", body: "topic",
    }))
    expect(searchSite("restricted topic", ["public"], 5, restricted)).toEqual([])
    expect(searchSite("restricted topic", ["public", "customer"], 5, restricted)).toEqual([])
  })
  it("returns [] for empty or stopword-only queries", () => {
    expect(searchSite("", ["public"], 5, articles)).toEqual([])
    expect(searchSite("how do I go to the", ["public"], 5, articles)).toEqual([])
  })
  it("weights title over body, ties by id, honours limit, counts distinct tokens once", () => {
    const set: SiteArticle[] = [
      { id: "b2", title: "Other", audiences: ["public"], keywords: [], summary: "", body: "refund refund refund refund refund" },
      { id: "a1", title: "Refund guide", audiences: ["public"], keywords: [], summary: "", body: "" },
      { id: "c3", title: "Other", audiences: ["public"], keywords: [], summary: "", body: "refund" },
    ]
    expect(searchSite("refund", ["public"], 5, set).map((a) => a.id)).toEqual(["a1", "b2", "c3"])
    expect(searchSite("refund", ["public"], 1, set).map((a) => a.id)).toEqual(["a1"])
  })
})
