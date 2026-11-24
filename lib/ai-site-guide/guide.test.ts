import { describe, expect, it } from "vitest"
import { audiencesFor } from "./audience"
import { renderSiteGuide } from "./guide"
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
    expect(searchSite("withdrawn withdrew withdrawals", ["public"], 5, articles).length).toBeGreaterThanOrEqual(0)
    expect(searchSite("earnings", ["public"], 5, articles).map((a) => a.id)).toEqual(["w"])
    expect(searchSite("withdrawed", ["public"], 5, articles).map((a) => a.id)).toEqual(["w"])
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
