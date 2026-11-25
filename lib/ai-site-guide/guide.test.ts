import { describe, expect, it } from "vitest"
import { audiencesFor } from "./audience"
import { checkSiteGuideLimits, renderSiteGuide, SITE_GUIDE_BUDGET_CHARS } from "./guide"
import { ARTICLES } from "./articles"
import { SITE_PAGES } from "./pages"
import { queryTokens, searchSite } from "./search"
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

describe("shop surfaces (hiddenOn)", () => {
  const sPages: SitePage[] = [
    { path: "/a", title: "Open Page", audiences: ["public"], purpose: "Fine.", tasks: ["x"] },
    { path: "/join", title: "Platform Page", audiences: ["public"], purpose: "Platform.", tasks: ["x"], hiddenOn: ["storefront", "whatsapp_shop"] },
    { path: "/join/shop/:handle", title: "Bot Hidden Page", audiences: ["public"], purpose: "Web only.", tasks: ["x"], hiddenOn: ["whatsapp_shop"] },
  ]
  const sArts: SiteArticle[] = [
    { id: "o", title: "Open Article", audiences: ["public"], keywords: ["thing"], summary: "thing", body: "thing" },
    { id: "p", title: "Platform Article", audiences: ["public"], keywords: ["thing"], summary: "thing", body: "thing", hiddenOn: ["storefront", "whatsapp_shop"] },
    { id: "b", title: "Bot Hidden Article", audiences: ["public"], keywords: ["thing"], summary: "thing", body: "thing", hiddenOn: ["whatsapp_shop"] },
  ]
  it("renderSiteGuide hides items only on the surfaces they list", () => {
    const store = renderSiteGuide(["public"], sPages, sArts, { surface: "storefront" })
    expect(store).toContain("Open Page")
    expect(store).toContain("Open Article")
    expect(store).toContain("Bot Hidden Page")
    expect(store).toContain("Bot Hidden Article")
    expect(store).not.toContain("Platform Page")
    expect(store).not.toContain("Platform Article")
    const bot = renderSiteGuide(["public"], sPages, sArts, { surface: "whatsapp_shop" })
    expect(bot).toContain("Open Page")
    expect(bot).not.toContain("Platform Page")
    expect(bot).not.toContain("Bot Hidden Page")
    expect(bot).not.toContain("Bot Hidden Article")
    const home = renderSiteGuide(["public"], sPages, sArts)
    for (const t of ["Platform Page", "Platform Article", "Bot Hidden Page", "Bot Hidden Article"]) expect(home).toContain(t)
  })
  it("searchSite hides articles only on the surfaces they list", () => {
    expect(searchSite("thing", ["public"], 5, sArts, { surface: "storefront" }).map((a) => a.id)).toEqual(["b", "o"])
    expect(searchSite("thing", ["public"], 5, sArts, { surface: "whatsapp_shop" }).map((a) => a.id)).toEqual(["o"])
    expect(searchSite("thing", ["public"], 5, sArts).map((a) => a.id)).toEqual(["b", "o", "p"])
  })
  it("the real guides never contain an item hidden on that surface; home still does", () => {
    const home = renderSiteGuide(["public"], SITE_PAGES, ARTICLES)
    for (const surface of ["storefront", "whatsapp_shop"] as const) {
      const shop = renderSiteGuide(["public"], SITE_PAGES, ARTICLES, { surface })
      const hiddenPages = SITE_PAGES.filter((p) => p.hiddenOn?.includes(surface))
      const hiddenArts = ARTICLES.filter((a) => a.hiddenOn?.includes(surface))
      expect(hiddenPages.length).toBeGreaterThan(0)
      expect(hiddenArts.length).toBeGreaterThan(0)
      for (const p of hiddenPages) {
        expect(shop).not.toContain(`(${p.path}):`)
        expect(home).toContain(`(${p.path}):`)
      }
      for (const a of hiddenArts) {
        expect(shop).not.toContain(a.title)
        expect(home).toContain(a.title)
        expect(searchSite(a.title, ["public"], 50, ARTICLES, { surface }).map((h) => h.id)).not.toContain(a.id)
      }
    }
  })
  it("keeps shop-line text to buy visible on shop surfaces", () => {
    for (const surface of ["storefront", "whatsapp_shop"] as const) {
      expect(renderSiteGuide(["public"], SITE_PAGES, ARTICLES, { surface })).toContain("shop's own number")
    }
  })
  it("main WhatsApp, main USSD, join and developer docs are hidden on both shop surfaces", () => {
    const both = ["storefront", "whatsapp_shop"]
    const hiddenPaths = SITE_PAGES.filter((p) => both.every((s) => p.hiddenOn?.includes(s as "storefront"))).map((p) => p.path)
    for (const path of ["/whatsapp", "/join", "/bulk-sms", "/developers", "/auth/signup", "/auth/login"]) {
      expect(hiddenPaths).toContain(path)
    }
    const hiddenIds = ARTICLES.filter((a) => both.every((s) => a.hiddenOn?.includes(s as "storefront"))).map((a) => a.id)
    for (const id of ["whatsapp-main-bot", "ussd-main-menu", "text-to-buy-customer", "become-a-dealer-or-agent", "developer-api-docs", "sms-send-bulk"]) {
      expect(hiddenIds).toContain(id)
    }
  })
  it("sub-agent join: explained on the storefront (it has a Join Now button) but not by the shop bot", () => {
    const sub = ARTICLES.find((a) => a.id === "sub-agent-join-a-shop")!
    expect(sub.hiddenOn).toEqual(["whatsapp_shop"])
    expect(SITE_PAGES.find((p) => p.path === "/join/shop/:handle")!.hiddenOn).toEqual(["whatsapp_shop"])
    expect(searchSite("join a shop as sub agent", ["public"], 5, ARTICLES, { surface: "storefront" }).map((a) => a.id)).toContain("sub-agent-join-a-shop")
    expect(searchSite("join a shop as sub agent", ["public"], 50, ARTICLES, { surface: "whatsapp_shop" }).map((a) => a.id)).not.toContain("sub-agent-join-a-shop")
    expect(renderSiteGuide(["public"], SITE_PAGES, ARTICLES, { surface: "storefront" })).toContain("(/join/shop/:handle):")
  })
  it("results-checker-buy-from-a-shop is visible on both shop surfaces and home", () => {
    const a = ARTICLES.find((x) => x.id === "results-checker-buy-from-a-shop")!
    expect(a.audiences).toEqual(["public"])
    expect(a.hiddenOn).toBeUndefined()
    for (const opts of [{ surface: "storefront" as const }, { surface: "whatsapp_shop" as const }, {}]) {
      expect(searchSite("how do i buy waec checker from this shop", ["public"], 5, ARTICLES, opts).map((x) => x.id)).toContain(a.id)
      expect(renderSiteGuide(["public"], SITE_PAGES, ARTICLES, { ...opts })).toContain(a.title)
    }
  })
})

describe("toolHint option", () => {
  const a: SiteArticle[] = [{ id: "o", title: "Open Article", audiences: ["public"], keywords: [], summary: "s", body: "b" }]
  const p: SitePage[] = [{ path: "/a", title: "Open Page", audiences: ["public"], purpose: "Fine.", tasks: ["x"] }]
  it("mentions get_knowledge_base by default and not when toolHint is false", () => {
    expect(renderSiteGuide(["public"], p, a)).toContain("get_knowledge_base")
    const out = renderSiteGuide(["public"], p, a, { toolHint: false })
    expect(out).not.toContain("get_knowledge_base")
    expect(out).not.toContain("Open Article") // no tool to read it with, so the titles are dropped
    expect(out).toContain("Open Page")
  })
  it("a guide with only articles and no tool hint is empty", () => {
    expect(renderSiteGuide(["public"], [], a, { toolHint: false })).toBe("")
  })
})

describe("short tokens", () => {
  it("two-letter words match nothing", () => {
    const arts: SiteArticle[] = [{ id: "o", title: "In of on", audiences: ["public"], keywords: ["in", "of"], summary: "in of", body: "in of on it no" }]
    expect(searchSite("in", ["public"], 5, arts)).toEqual([])
    expect(searchSite("of", ["public"], 5, arts)).toEqual([])
    expect(queryTokens("in of on refunds")).toEqual(["refund"])
  })
})
