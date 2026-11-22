import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

const read = (file: string) => readFileSync(path.join(process.cwd(), "app/shop/[slug]", file), "utf8")

const page = read("order-status/page.tsx")
const storefront = read("storefront-client.tsx")
// The tracker is the last component in the file; checkout above it legitimately handles buyer details.
const trackerStart = storefront.indexOf("function OrderStatusSearch(")
const tracker = storefront.slice(trackerStart)

const PUBLIC_FIELDS = [
  "id", "type", "reference_code", "network", "volume_gb", "total_price",
  "order_status", "payment_status", "created_at", "updated_at",
]
const REMOVED = /customer_name|customer_email|customer_phone|beneficiary_phone|base_price|profit_amount/

it("finds the storefront tracker", () => expect(trackerStart).toBeGreaterThan(0))

describe.each([
  ["order-status page", page],
  ["storefront tracker", tracker],
])("%s", (_name, source) => {
  it("references no removed field", () => expect(source).not.toMatch(REMOVED))

  it("reads only fields the search returns", () => {
    const used = [...source.matchAll(/\border\??\.(\w+)/g)].map((m) => m[1])
    expect(used.length).toBeGreaterThan(0)
    expect(used.filter((field) => !PUBLIC_FIELDS.includes(field))).toEqual([])
  })

  it("has no tile for a removed value", () => {
    expect(source).not.toMatch(/>(Price|Customer|Customer Name|Phone|Email)<\/p>/)
  })

  it("still shows the total", () => expect(source).toContain("order.total_price"))
})

it("order-status page declares exactly the search fields", () => {
  const body = page.match(/interface ShopOrder \{([\s\S]*?)\n\}/)![1]
  expect([...body.matchAll(/^\s*(\w+)\??:/gm)].map((m) => m[1]).sort()).toEqual([...PUBLIC_FIELDS].sort())
})
