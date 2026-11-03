// A closed shop (is_active=false: an unpriced storefront joiner, or a shop awaiting approval) must not sell on any
// channel. Every public route that turns a storefront handle into a shop id must keep only active shops; this pins
// that filter so a later edit cannot drop it silently. Code-based channels (USSD, Hubtel, WhatsApp, the shop AI tools)
// use resolveShopCode's status instead and are covered by their own tests.
import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const ROOT = join(__dirname, "..", "..")
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8")

const HANDLE_ROUTES = [
  "app/api/shop/orders/create/route.ts",
  "app/api/payments/initialize/route.ts",
  "app/api/shop/airtime/initialize/route.ts",
  "app/api/shop/airtime/public-constraints/route.ts",
  "app/api/shop/afa/initialize/route.ts",
  "app/api/shop/results-checker/initialize/route.ts",
  "app/api/shop/results-check/initialize/route.ts",
  "app/api/public/shop-ussd-code/route.ts",
  "lib/storefront-commission/shop.ts",
]

/** Each `.or(shopHandleOrFilter(...))` query, from the filter to its terminal call. */
function handleQueries(src: string): string[] {
  const out: string[] = []
  const re = /\.or\(shopHandleOrFilter\(/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    const rest = src.slice(m.index)
    const end = rest.search(/\.(single|maybeSingle|limit)\(/)
    out.push(end === -1 ? rest : rest.slice(0, end))
  }
  return out
}

describe("sell paths keep only active shops", () => {
  for (const file of HANDLE_ROUTES) {
    it(`${file}: every handle lookup filters is_active = true`, () => {
      const queries = handleQueries(read(file))
      expect(queries.length).toBeGreaterThan(0)
      for (const q of queries) expect(q).toMatch(/\.eq\(\s*["']is_active["']\s*,\s*true\s*\)/)
    })
  }

  it("orders/create refuses an inactive shop on every path (the shop_id lookup, not only the slug one)", () => {
    const src = read("app/api/shop/orders/create/route.ts")
    expect(src).toMatch(/\.select\("parent_shop_id, user_id, is_blocked, is_active"\)/)
    expect(src).toMatch(/shopData\?\.is_active !== true/)
  })
})
