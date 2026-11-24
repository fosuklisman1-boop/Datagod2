import { describe, expect, it } from "vitest"
import { queryTokens, searchSite } from "./search"
import { isShopOwnerFor } from "./shop-owner"
import type { SiteArticle } from "./types"

describe("queryTokens", () => {
  it("uses the same stemming and stopwords as searchSite, [a-z0-9] only, deduped", () => {
    expect(queryTokens("How do I get my REFUNDS refunds?")).toEqual(["get", "refund"])
  })

  it("strips every non-alphanumeric character (no SQL/PostgREST metacharacters survive)", () => {
    const t = queryTokens("100%_ ,) or(id.eq.1) \\ ' \"")
    expect(t.length).toBeGreaterThan(0)
    for (const x of t) expect(x).toMatch(/^[a-z0-9]+$/)
  })

  it("caps at 6 tokens", () => {
    expect(queryTokens("alpha bravo charlie delta echo foxtrot golf hotel")).toHaveLength(6)
  })

  it("matches what searchSite would match", () => {
    const a: SiteArticle = {
      id: "x", title: "Wallet refunds", audiences: ["public"], keywords: [], summary: "s", body: "b",
    }
    expect(searchSite("refunds", ["public"], 5, [a])).toHaveLength(1)
    expect(queryTokens("refunds")).toEqual(["refund"])
  })
})

function fakeDb(result: { data?: unknown; error?: unknown; throws?: boolean }) {
  const calls: Array<{ table: string; eq: unknown[][] }> = []
  return {
    calls,
    db: {
      from(table: string) {
        if (result.throws) throw new Error("boom")
        const call = { table, eq: [] as unknown[][] }
        calls.push(call)
        const b: any = {
          select: () => b,
          eq: (...a: unknown[]) => { call.eq.push(a); return b },
          limit: () => b,
          then: (res: any, rej: any) =>
            Promise.resolve({ data: result.data ?? null, error: result.error ?? null }).then(res, rej),
        }
        return b
      },
    } as any,
  }
}

describe("isShopOwnerFor", () => {
  it("true when the user owns a shop row", async () => {
    const f = fakeDb({ data: [{ id: "s1" }] })
    expect(await isShopOwnerFor(f.db, "u1")).toBe(true)
    expect(f.calls[0].table).toBe("user_shops")
    expect(f.calls[0].eq).toContainEqual(["user_id", "u1"])
  })
  it("false with no rows, an error, or a throw (fails closed)", async () => {
    expect(await isShopOwnerFor(fakeDb({ data: [] }).db, "u1")).toBe(false)
    expect(await isShopOwnerFor(fakeDb({ error: { message: "x" } }).db, "u1")).toBe(false)
    expect(await isShopOwnerFor(fakeDb({ throws: true }).db, "u1")).toBe(false)
  })
})
