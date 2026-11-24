import { describe, it, expect, vi, beforeEach } from "vitest"

const h = vi.hoisted(() => ({
  rows: [] as Array<{ category: string; question: string; answer: string }>,
  error: null as null | { message: string },
  calls: [] as Array<{ table: string; contains: unknown[][]; or: string[]; eq: unknown[][]; limit: number[] }>,
}))

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: (table: string) => {
      const call = { table, contains: [] as unknown[][], or: [] as string[], eq: [] as unknown[][], limit: [] as number[] }
      h.calls.push(call)
      const b: any = {
        select: () => b,
        eq: (...a: unknown[]) => { call.eq.push(a); return b },
        contains: (...a: unknown[]) => { call.contains.push(a); return b },
        or: (s: string) => { call.or.push(s); return b },
        limit: (n: number) => { call.limit.push(n); return b },
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
  it("returns site articles (as category 'site') before DB rows, one shape", async () => {
    h.rows = [{ category: "Refunds", question: "DB question", answer: "DB-ANSWER" }]
    const r = await run("refunds")
    expect(r.entries[0]).toEqual({ category: "site", question: "Wallet refunds", answer: "SITE-REFUND-BODY" })
    expect(r.entries[1]).toEqual({ category: "Refunds", question: "DB question", answer: "DB-ANSWER" })
    expect(r.found).toBe(2)
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
    expect(r.entries[0].category).toBe("site")
  })

  it("DB error with site hits still answers; with nothing at all it reports the error", async () => {
    h.error = { message: "db down" }
    const withSite = await run("refunds")
    expect(withSite.entries[0].question).toBe("Wallet refunds")
    const none = await run("zzzzunmatched")
    expect(none.error).toBe("db down")
  })

  it("nothing found", async () => {
    const r = await run("zzzzunmatched")
    expect(r.found).toBe(0)
  })
})
