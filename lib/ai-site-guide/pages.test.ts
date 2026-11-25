import { describe, it, expect } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { SITE_PAGES } from "./pages"
import { EXCLUDED_PAGES } from "./excluded-pages"
import { checkSiteGuideLimits, renderSiteGuide } from "./guide"
import { ARTICLES } from "./articles"

const APP_DIR = path.resolve(__dirname, "../../app")

function discover(dir: string, parts: string[] = []): string[] {
  const out: string[] = []
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.isDirectory()) {
      if (parts.length === 0 && (ent.name === "admin" || ent.name === "api")) continue
      const part = /^\(.*\)$/.test(ent.name) ? null : ent.name.replace(/^\[(.+)\]$/, ":$1")
      out.push(...discover(path.join(dir, ent.name), part ? [...parts, part] : parts))
    } else if (ent.name === "page.tsx") {
      out.push("/" + parts.join("/"))
    }
  }
  return out
}

describe("customer page guide", () => {
  const onDisk = discover(APP_DIR)
  const listed = SITE_PAGES.map((p) => p.path)
  const excluded = EXCLUDED_PAGES.map((e) => e.path)

  it("finds a plausible number of pages on disk", () => {
    expect(onDisk.length).toBeGreaterThan(60)
  })

  it("every page has exactly one entry or one excluded row, and nothing stale", () => {
    expect(new Set(listed).size).toBe(listed.length)
    expect(new Set(excluded).size).toBe(excluded.length)
    expect(listed.filter((p) => excluded.includes(p))).toEqual([])
    expect([...listed, ...excluded].sort()).toEqual([...onDisk].sort())
  })

  it("excluded rows carry a real reason", () => {
    for (const e of EXCLUDED_PAGES) expect(e.reason.trim().length, e.path).toBeGreaterThan(15)
  })

  it("keeps fields within limits", () => {
    for (const p of SITE_PAGES) {
      expect(p.title.trim().length, p.path).toBeGreaterThan(0)
      expect(p.purpose.length, p.path).toBeGreaterThan(0)
      expect(p.purpose.length, p.path).toBeLessThanOrEqual(90)
      expect(p.tasks.length, p.path).toBeGreaterThanOrEqual(1)
      expect(p.tasks.length, p.path).toBeLessThanOrEqual(5)
      expect(p.audiences.length, p.path).toBeGreaterThan(0)
    }
  })

  it("dashboard pages are never public", () => {
    for (const p of SITE_PAGES.filter((x) => x.path.startsWith("/dashboard"))) {
      expect(p.audiences, p.path).not.toContain("public")
    }
  })

  it("shop-management pages are tagged shop_owner and kept off customer", () => {
    const shopOnly = [
      "/dashboard/shop-orders", "/dashboard/shop-pricing", "/dashboard/shop-profile", "/dashboard/shop-withdraw",
      "/dashboard/shop-profit-logs", "/dashboard/shop-dashboard", "/dashboard/customers", "/dashboard/text-orders",
      "/dashboard/sub-agents", "/dashboard/sub-agent-catalog", "/dashboard/ussd-shop", "/dashboard/blocked-numbers",
    ]
    for (const p of shopOnly) {
      const e = SITE_PAGES.find((x) => x.path === p)
      expect(e, p).toBeDefined()
      expect(e!.audiences, p).toContain("shop_owner")
      expect(e!.audiences, p).not.toContain("customer")
    }
  })

  it("pages a plain signed-in user can use are tagged customer", () => {
    const open = SITE_PAGES.filter((p) => p.path.startsWith("/dashboard/sms")).map((p) => p.path)
    expect(open.length).toBe(7)
    for (const p of [...open, "/dashboard/my-shop", "/auth/complete-profile"]) {
      expect(SITE_PAGES.find((x) => x.path === p)?.audiences, p).toContain("customer")
    }
    expect(SITE_PAGES.find((x) => x.path === "/auth/complete-profile")?.audiences).not.toContain("public")
  })

  it("payment re-check describes the pending-orders list", () => {
    const e = SITE_PAGES.find((x) => x.path === "/dashboard/payment-reverify")!
    expect(`${e.purpose} ${e.tasks.join(" ")}`).toMatch(/pending/i)
  })

  it("storefront and public pages are public", () => {
    for (const p of ["/", "/shop/:slug", "/shop/:slug/checkout", "/auth/login", "/developers"]) {
      expect(SITE_PAGES.find((x) => x.path === p)?.audiences, p).toContain("public")
    }
  })

  it("keeps secrets, thresholds and internals out of non-admin text", () => {
    const banned = /fraud|threshold|blacklist|supabase|\.tsx?\b|service[_ ]role/i
    for (const p of SITE_PAGES.filter((x) => !x.audiences.includes("admin"))) {
      expect(`${p.title} ${p.purpose} ${p.tasks.join(" ")}`, p.path).not.toMatch(banned)
    }
  })

  it("real data passes the guide limits for every audience set", () => {
    expect(checkSiteGuideLimits(SITE_PAGES, ARTICLES)).toEqual([])
    expect(renderSiteGuide(["public", "customer", "dealer", "shop_owner", "admin"]).length).toBeLessThanOrEqual(10000)
  })
})
