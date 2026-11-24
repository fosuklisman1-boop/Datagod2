import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"
import { resetKnowledgeCache } from "@/lib/ai-prompts/knowledge"

const h = vi.hoisted(() => ({
  runAgenticLoop: vi.fn(),
  authed: true,
  role: "user" as string,
  ownsShop: false,
  shopLookupThrows: false,
  tables: [] as string[],
}))

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    auth: { getUser: async () => (h.authed ? { data: { user: { id: "user-1" } }, error: null } : { data: { user: null }, error: { message: "bad" } }) },
    from: (table: string) => {
      h.tables.push(table)
      if (table === "user_shops" && h.shopLookupThrows) throw new Error("shops down")
      const row =
        table === "users" ? { first_name: "A", last_name: "B", phone_number: "0240000000", role: h.role, is_suspended: false }
        : table === "user_shops" ? (h.ownsShop ? { id: "shop-1" } : null)
        : null
      const b: any = {
        select: () => b, eq: () => b, is: () => b, limit: () => b, or: () => b, contains: () => b, order: () => b, in: () => b,
        single: async () => ({ data: row, error: null }),
        maybeSingle: async () => ({ data: row, error: null }),
        then: (res: any, rej: any) =>
          Promise.resolve({ data: table === "user_shops" ? (h.ownsShop ? [row] : []) : row ? [row] : [], error: null }).then(res, rej),
      }
      return b
    },
  }),
}))
vi.mock("@/lib/rate-limiter", () => ({ applyRateLimit: async () => ({ allowed: true }) }))
vi.mock("@/lib/ai-providers", () => ({
  DEFAULT_CONFIG: {},
  resolveProviderForContext: () => ({ provider: {}, model: "m", providerName: "p" }),
}))
vi.mock("@/lib/custom-domain-lookup", () => ({ resolveCustomDomain: async () => null }))
vi.mock("@/lib/ai-agentic-loop", () => ({ runAgenticLoop: h.runAgenticLoop }))
vi.mock("@/lib/ai-drafts/repo", () => ({ terminalDraftsSince: async () => [] }))

// Real engine, fake content: the shipped content arrives in later tasks.
vi.mock("@/lib/ai-site-guide/pages", () => ({
  SITE_PAGES: [
    { path: "/pub", title: "PubPageTitle", audiences: ["public"], purpose: "p", tasks: ["t"] },
    { path: "/cust", title: "CustPageTitle", audiences: ["customer"], purpose: "p", tasks: ["t"] },
    { path: "/deal", title: "DealerPageTitle", audiences: ["dealer"], purpose: "p", tasks: ["t"] },
    { path: "/shop", title: "ShopOwnerPageTitle", audiences: ["shop_owner"], purpose: "p", tasks: ["t"] },
    { path: "/adm", title: "AdminPageTitle", audiences: ["admin"], purpose: "p", tasks: ["t"] },
  ],
}))

import { POST } from "./route"

async function post(context: string, auth = true) {
  const headers: Record<string, string> = { "content-type": "application/json" }
  if (auth) headers.authorization = "Bearer tok"
  const res = await POST(new NextRequest("http://localhost/api/ai/chat", {
    method: "POST", headers,
    body: JSON.stringify({ context, messages: [{ role: "user", content: "hi" }] }),
  }))
  await res.text()
  const call = h.runAgenticLoop.mock.calls.at(-1)?.[0] as { system: { stable: string } | string }
  return typeof call.system === "string" ? call.system : call.system.stable
}

beforeEach(() => {
  vi.resetAllMocks()
  resetKnowledgeCache()
  h.authed = true
  h.role = "user"
  h.ownsShop = false
  h.shopLookupThrows = false
  h.tables = []
  h.runAgenticLoop.mockResolvedValue({ text: "", toolsUsed: [] })
})

describe("chat route site guide", () => {
  it("home prompt has the public guide only", async () => {
    const s = await post("home", false)
    expect(s).toContain("PubPageTitle")
    for (const t of ["CustPageTitle", "DealerPageTitle", "ShopOwnerPageTitle", "AdminPageTitle"]) expect(s).not.toContain(t)
  })

  it("storefront prompt is public only even for a signed-in dealer", async () => {
    h.role = "dealer"
    const s = await post("storefront", true)
    expect(s).toContain("PubPageTitle")
    expect(s).not.toContain("DealerPageTitle")
    expect(s).not.toContain("CustPageTitle")
  })

  it("dashboard user: public + customer, no dealer/shop/admin", async () => {
    const s = await post("dashboard")
    expect(s).toContain("CustPageTitle")
    for (const t of ["DealerPageTitle", "ShopOwnerPageTitle", "AdminPageTitle"]) expect(s).not.toContain(t)
  })

  it("dashboard dealer (role from the DB) gets dealer titles", async () => {
    h.role = "dealer"
    const s = await post("dashboard")
    expect(s).toContain("DealerPageTitle")
    expect(s).not.toContain("AdminPageTitle")
    expect(s).not.toContain("ShopOwnerPageTitle")
  })

  it("dashboard shop owner (user_shops row) gets shop owner titles", async () => {
    h.ownsShop = true
    const s = await post("dashboard")
    expect(s).toContain("ShopOwnerPageTitle")
    expect(s).not.toContain("DealerPageTitle")
  })

  it("shop lookup failure fails closed: no shop owner titles, chat still answers", async () => {
    h.ownsShop = true
    h.shopLookupThrows = true
    const s = await post("dashboard")
    expect(s).toContain("CustPageTitle")
    expect(s).not.toContain("ShopOwnerPageTitle")
  })

  it("admin prompt contains all", async () => {
    h.role = "admin"
    const s = await post("admin")
    for (const t of ["PubPageTitle", "CustPageTitle", "DealerPageTitle", "ShopOwnerPageTitle", "AdminPageTitle"]) {
      expect(s).toContain(t)
    }
  })

  it("a dashboard admin gets everything", async () => {
    h.role = "admin"
    const s = await post("dashboard")
    expect(s).toContain("AdminPageTitle")
  })

  it("the guide sits inside the knowledge section with its rule line", async () => {
    const s = await post("home", false)
    expect(s).toContain("owner's latest word")
    expect(s.indexOf("owner's latest word")).toBeLessThan(s.indexOf("## Site guide"))
  })
})
