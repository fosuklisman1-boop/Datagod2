import { describe, it, expect, vi, beforeEach } from "vitest"

const h = vi.hoisted(() => ({
  rows: [] as Array<{ category: string; question: string; answer: string }>,
  error: null as null | { message: string },
  calls: [] as Array<{ table: string; contains: unknown[][]; or: string[]; eq: unknown[][]; limit: number[]; steps: string[]; order: unknown[][] }>,
}))

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: (table: string) => {
      const call = { table, contains: [] as unknown[][], or: [] as string[], eq: [] as unknown[][], limit: [] as number[], steps: [] as string[], order: [] as unknown[][] }
      h.calls.push(call)
      const b: any = {
        select: () => b,
        eq: (...a: unknown[]) => { call.eq.push(a); return b },
        contains: (...a: unknown[]) => { call.contains.push(a); return b },
        or: (s: string) => { call.or.push(s); return b },
        order: (...a: unknown[]) => { call.order.push(a); call.steps.push("order"); return b },
        limit: (n: number) => { call.limit.push(n); call.steps.push("limit"); return b },
        then: (res: any, rej: any) =>
          Promise.resolve({ data: h.error ? null : h.rows, error: h.error }).then(res, rej),
      }
      return b
    },
  }),
}))

// Real site-guide engine, fake content (the shipped content arrives in later tasks).
vi.mock("@/lib/ai-site-guide/articles", () => ({
  ARTICLES: [
    { id: "w1", title: "Wallet refunds", audiences: ["public"], keywords: ["refund"], summary: "How refunds reach your wallet", body: "SITE-REFUND-BODY" },
    { id: "d1", title: "Dealer pricing", audiences: ["dealer"], keywords: ["pricing"], summary: "Dealer price tiers", body: "DEALER-ONLY-BODY" },
    { id: "a1", title: "Admin refund queue", audiences: ["admin"], keywords: ["refund"], summary: "Admin refunds", body: "ADMIN-ONLY-BODY" },
    ...[1, 2, 3, 4, 5, 6].map((n) => ({ id: `s${n}`, title: `Guide ${n}`, audiences: ["public"], keywords: ["refund"], summary: "x", body: `SITE-S${n}` })),
    { id: "p1", title: "Reseller signup", audiences: ["public"], keywords: ["reseller"], summary: "Become a reseller", body: "PLATFORM-ONLY-BODY", platformOnly: true },
  ],
}))

import { executeToolCall, type ToolContext } from "@/lib/ai-tools"

const run = (query: string, ctx: Partial<ToolContext> = {}) =>
  executeToolCall("get_knowledge_base", { query }, { baseUrl: "http://x", context: "dashboard", userId: "u1", userRole: "user", ...ctx }) as Promise<any>

const dbCall = () => h.calls.find((c) => c.table === "ai_knowledge")!

beforeEach(() => {
  h.rows = []
  h.error = null
  h.calls = []
})

describe("get_knowledge_base", () => {
  it("returns DB rows first, then site articles (as category 'site'), one shape", async () => {
    h.rows = [{ category: "Refunds", question: "DB question", answer: "DB-ANSWER" }]
    const r = await run("refunds")
    expect(r.entries[0]).toEqual({ category: "Refunds", question: "DB question", answer: "DB-ANSWER" })
    expect(r.entries[1]).toEqual({ category: "site", question: "Wallet refunds", answer: "SITE-REFUND-BODY" })
    expect(r.found).toBe(5)
  })

  it("owner DB rows are never crowded out by 5+ matching site articles", async () => {
    h.rows = [
      { category: "Refunds", question: "Refund policy", answer: "OWNER-1" },
      { category: "Refunds", question: "Refund time", answer: "OWNER-2" },
    ]
    const r = await run("refunds")
    expect(r.entries).toHaveLength(5)
    expect(r.entries[0].answer).toBe("OWNER-1")
    expect(r.entries[1].answer).toBe("OWNER-2")
    expect(r.entries.slice(2).every((e: any) => e.category === "site")).toBe(true)
  })

  it("caps DB rows at 3 up front so site articles keep some slots", async () => {
    h.rows = Array.from({ length: 5 }, (_, i) => ({ category: "c", question: `Row${i}`, answer: `ROW-${i}` }))
    const r = await run("refunds")
    expect(r.entries.map((e: any) => e.category)).toEqual(["c", "c", "c", "site", "site"])
  })

  it("with no DB matches it returns 5 site articles", async () => {
    const r = await run("refunds")
    expect(r.entries).toHaveLength(5)
    expect(r.entries.every((e: any) => e.category === "site")).toBe(true)
  })

  it("never returns platformOnly articles on shop surfaces, but does on the home chat", async () => {
    for (const context of ["storefront", "whatsapp_shop"] as const) {
      const shop = JSON.stringify(await run("reseller", { context, userId: undefined, userRole: "guest" }))
      expect(shop).not.toContain("PLATFORM-ONLY-BODY")
    }
    const home = JSON.stringify(await run("reseller", { context: "home", userId: undefined, userRole: "guest" }))
    expect(home).toContain("PLATFORM-ONLY-BODY")
  })

  it("scopes site articles by the verified audience", async () => {
    const dash = JSON.stringify(await run("pricing refund"))
    expect(dash).not.toContain("DEALER-ONLY-BODY")
    expect(dash).not.toContain("ADMIN-ONLY-BODY")
    const dealer = JSON.stringify(await run("pricing", { userRole: "dealer" }))
    expect(dealer).toContain("DEALER-ONLY-BODY")
    const admin = JSON.stringify(await run("refund", { context: "admin", userRole: "admin" }))
    expect(admin).toContain("ADMIN-ONLY-BODY")
    const guest = JSON.stringify(await run("refund", { context: "home", userId: undefined, userRole: "guest" }))
    expect(guest).not.toContain("ADMIN-ONLY-BODY")
  })

  it("never leaks admin articles on the WhatsApp main bot, even for an admin's number", async () => {
    const wa = JSON.stringify(await run("refund", { context: "whatsapp", userRole: "admin" }))
    expect(wa).not.toContain("ADMIN-ONLY-BODY")
  })

  it("builds the DB filter from tokens only: each token ilike on question/answer/category, max 6, no raw query", async () => {
    await run("100%_ ,) or(id.eq.1) refunds alpha bravo charlie delta echo foxtrot")
    const or = dbCall().or[0]
    expect(dbCall().or).toHaveLength(1)
    expect(or).not.toContain("(id.eq") // raw query text never appears
    expect(or).not.toContain("or(")
    expect(or).not.toContain(")")
    const terms = or.split(",")
    expect(terms.length).toBeLessThanOrEqual(6 * 3)
    for (const t of terms) expect(t).toMatch(/^(question|answer|category)\.ilike\.%[a-z0-9]+%$/)
    const tokens = new Set(terms.map((t) => t.split(".ilike.")[1]))
    expect(tokens.size).toBeLessThanOrEqual(6)
  })

  it("a query of only metacharacters builds no filter and does not touch the table", async () => {
    const r = await run("%_,)")
    expect(h.calls.some((c) => c.table === "ai_knowledge")).toBe(false)
    expect(r.found).toBe(0)
  })

  it("scopes DB rows by the verified context label", async () => {
    await run("refunds", { context: "admin", userRole: "admin" })
    expect(dbCall().contains[0]).toEqual(["contexts", ["admin"]])
    h.calls = []
    await run("refunds", { context: "dashboard", userRole: "user" })
    expect(dbCall().contains[0]).toEqual(["contexts", ["dashboard"]])
    h.calls = []
    await run("refunds", { context: "home", userId: undefined, userRole: "guest" })
    expect(dbCall().contains[0]).toEqual(["contexts", ["storefront"]])
  })

  it("dedupes by title/question and caps at 5", async () => {
    h.rows = [
      { category: "x", question: "wallet refunds", answer: "dup of the site title" },
      ...Array.from({ length: 6 }, (_, i) => ({ category: "c", question: `Q${i}`, answer: `A${i}` })),
    ]
    const r = await run("refunds")
    expect(r.entries).toHaveLength(5)
    const titles = r.entries.map((e: any) => e.question.toLowerCase())
    expect(new Set(titles).size).toBe(titles.length)
    // DB rows come first; a site article with the same title as a DB row is the one dropped.
    expect(r.entries[0].category).toBe("x")
    expect(r.entries.filter((e: any) => e.category === "site").map((e: any) => e.question)).not.toContain("Wallet refunds")
  })

  it("DB error with site hits still answers; with nothing at all it reports the error", async () => {
    h.error = { message: "db down" }
    const withSite = await run("refunds")
    expect(withSite.entries[0].question).toBe("Wallet refunds")
    expect(withSite.entries).toHaveLength(5)
    const none = await run("zzzzunmatched")
    expect(none.error).toBe("db down")
  })

  it("orders DB rows deterministically (category, then question) before the limit", async () => {
    await run("refunds")
    const c = dbCall()
    expect(c.order).toEqual([["category", { ascending: true }], ["question", { ascending: true }]])
    expect(c.steps).toEqual(["order", "order", "limit"])
    expect(c.limit).toEqual([5])
  })

  it("ignores tokens shorter than 3 characters in the DB filter", async () => {
    await run("x 7 in of refunds")
    const or = dbCall().or[0]
    expect(or).toContain("%refund%")
    expect(or).not.toMatch(/%[a-z0-9]{1,2}%/)
  })

  it("a query of only two-letter words does not touch the table and finds nothing", async () => {
    const r = await run("in of on it")
    expect(h.calls.some((c) => c.table === "ai_knowledge")).toBe(false)
    expect(r.found).toBe(0)
  })

  it("a query of only one-character tokens does not touch the table", async () => {
    await run("x 7 q")
    expect(h.calls.some((c) => c.table === "ai_knowledge")).toBe(false)
  })

  it("nothing found", async () => {
    const r = await run("zzzzunmatched")
    expect(r.found).toBe(0)
  })
})
