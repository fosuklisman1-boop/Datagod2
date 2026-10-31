// lib/pricing/guard.test.ts
import { describe, it, expect } from "vitest"
import { execSync } from "child_process"
import { readFileSync } from "fs"

// Files allowed to mention dealer_price. Every one either edits package prices (admin), shows the
// role price on purpose (selling prices stay role + margin), or only passes the column through.
const ALLOWED = new Set([
  // The resolver itself.
  "lib/pricing/package-price.ts",
  // Bulk price tool: edits the dealer_price column, does not charge anyone.
  "lib/bulk-package-pricing.ts",
  // Admin package editors and routes: they edit the price columns.
  "app/admin/packages/page.tsx",
  "app/api/admin/packages/route.ts",
  "app/api/admin/packages/bulk-update-price/route.ts",
  // Role change: recalculates role-based data, not a charge.
  "app/api/admin/users/update-role/route.ts",
  // Custom-prices admin route and dialog: show the dealer price as a reference and warning.
  "app/api/admin/users/[id]/custom-prices/route.ts",
  "components/admin/CustomPricesDialog.tsx",
  "lib/pricing/custom-prices-dialog.ts",
  // Pass-through of the dealer_price column in the public API v2 store/catalog.
  "lib/api-v2/order-store.ts",
  "lib/api-v2/bundles.ts",
  // Selling prices stay role price + margin, so these show the role price on purpose.
  "app/api/shop/public-packages/route.ts",
  "app/api/shop/invites/[code]/route.ts",
  "app/api/shop/dealer-price-list/route.ts",
  "app/api/shop/sub-agent-catalog/route.ts",
  "app/api/shop/parent-packages/route.ts",
  "app/dashboard/shop-pricing/page.tsx",
  "app/dashboard/sub-agent-catalog/page.tsx",
  // The admin view lists dealer_price as a field; the price choices use the resolver.
  "lib/ai-tools.ts",
  // Mobile app: cannot import the resolver (separate package). Its prices come from /api/user/package-prices;
  // the dealer rule is only the display fallback when that call fails, and purchases are re-priced server-side.
  "mobile/src/lib/datagod.ts",
])

// A copy of the rule looks like `dealer_price && ... > 0 ? ... dealer_price` or `dealer_price ?? price`.
// It is single-line: match it against `collapse(contents)` so a ternary split over several lines is caught.
export const RULE = /dealer_price[^\n]{0,80}(>\s*0|\?\?)[^\n]{0,80}(dealer_price|\bprice\b)/

/** File contents with every run of whitespace (newlines included) collapsed to one space. */
export const collapse = (text: string) => text.replace(/\s+/g, " ")

// Candidate files. Pathspec `*` matches across "/", but "dir/**/*.ts" still needs one more "/", so the
// top-level files of each directory need their own "dir/*.ts" entry.
const PATHSPECS = [
  "app/*.ts", "app/*.tsx", "app/**/*.ts", "app/**/*.tsx",
  "lib/*.ts", "lib/**/*.ts",
  "components/*.tsx", "components/**/*.tsx",
  "mobile/**/*.ts", "mobile/**/*.tsx",
]

describe("price rule regex", () => {
  it("matches the common forms of the rule", () => {
    expect(RULE.test("pkg.dealer_price && pkg.dealer_price > 0 ? pkg.dealer_price : pkg.price")).toBe(true)
    expect(RULE.test("const p = dealer_price ?? price")).toBe(true)
    expect(RULE.test("Number(row.dealer_price) > 0 ? Number(row.dealer_price) : Number(row.price)")).toBe(true)
  })
  it("matches a rule split over several lines once collapsed", () => {
    const sample = `price: userRole === "dealer" && pkg.dealer_price && pkg.dealer_price > 0
            ? pkg.dealer_price
            : pkg.price,`
    const sample2 = `const p = pkg.dealer_price
      ?? pkg.price`
    expect(RULE.test(collapse(sample))).toBe(true)
    expect(RULE.test(collapse(sample2))).toBe(true)
  })
  it("does not match a plain column list", () => {
    expect(RULE.test('.select("id, price, dealer_price")')).toBe(false)
  })
})

describe("price rule lives only in lib/pricing/package-price.ts", () => {
  it("no other file re-implements the dealer/role price choice", () => {
    // git grep only lists candidate files; contents are read from the working tree.
    const out = execSync(
      `git grep -l "dealer_price" -- ${PATHSPECS.map((p) => `"${p}"`).join(" ")} ":!*.test.ts" ":!*.test.tsx"`,
      { encoding: "utf8" },
    )
    const offenders = out
      .split("\n")
      .filter(Boolean)
      .filter((f) => {
        if (ALLOWED.has(f)) return false
        return RULE.test(collapse(readFileSync(f, "utf8")))
      })
    expect(offenders).toEqual([])
  })
})
