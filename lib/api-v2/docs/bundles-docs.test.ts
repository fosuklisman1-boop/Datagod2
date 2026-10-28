import { describe, it, expect } from "vitest"
import { signBundleToken } from "@/lib/standard-bundles/token"
import { v2DocsRegistry } from "./registry"
import { DEFAULT_LIMITS } from "../limits"
import * as rules from "../bundles"
import * as bundlesMod from "../endpoints/bundles"
import {
  MSG_UNAUTHORIZED,
  MSG_UNAVAILABLE,
  MSG_SUSPENDED,
  MSG_PENDING,
  MSG_REVOKED,
  MSG_ROLE_NOT_ALLOWED,
  MSG_RATE_LIMITED,
  msgWrongKeyType,
} from "../access"
import { MSG_PHONE_GATE, MSG_REFERENCE_REUSED, MSG_UNAVAILABLE as MSG_CATALOG_UNAVAILABLE } from "../endpoints/data"
import { MSG_CLAIM_UNAVAILABLE, MSG_SANDBOX_UNAVAILABLE } from "../endpoints/airtime"

const endpoints = v2DocsRegistry.flatMap((s) => s.endpoints)
type Ep = (typeof endpoints)[number]
const find = (sig: string): Ep => endpoints.find((x) => `${x.method} ${x.path}` === sig)!
const prose = (id: string) => v2DocsRegistry.find((s) => s.id === id)!
const text = (s: { intro?: string; steps?: string[]; callouts?: { body: string; title?: string }[] }) =>
  [s.intro ?? "", ...(s.steps ?? []), ...(s.callouts ?? []).flatMap((c) => [c.title ?? "", c.body])].join(" ")

const BUNDLES = {
  catalog: "GET /bundles/catalog",
  purchase: "POST /bundles/purchase",
  list: "GET /bundles/orders",
  order: "GET /bundles/orders/{reference}",
}
const sigs = Object.values(BUNDLES)
const limitRe = (n: number, g: string) => new RegExp(`${n} requests per minute \\(${g} group\\)`)
const access403 = [MSG_SUSPENDED, MSG_PENDING, MSG_REVOKED, msgWrongKeyType("commission"), MSG_ROLE_NOT_ALLOWED]

const SECRET = "test-secret-not-real"
const realToken = () => signBundleToken({ network: "MTN", value: "1GB-VAL", amount: 5.5, display: "1GB", category: "Data", issuedAt: Date.now() }, SECRET)

describe("v2DocsRegistry Standard Bundles endpoints", () => {
  it("documents the four endpoints with key type commission in the commission group", () => {
    for (const sig of sigs) {
      const e = find(sig)
      expect(e, sig).toBeDefined()
      expect(e.keyType).toBe("commission")
      expect(e.group).toBe("commission")
      expect(e.notes.length).toBeGreaterThan(0)
      expect(e.summary.length).toBeGreaterThan(20)
    }
    expect(sigs).toHaveLength(4)
  })

  it("takes rate-limit strings from limits.ts", () => {
    expect(find(BUNDLES.purchase).rateLimit).toMatch(limitRe(DEFAULT_LIMITS.purchase, "purchase"))
    for (const sig of [BUNDLES.catalog, BUNDLES.list, BUNDLES.order]) {
      expect(find(sig).rateLimit).toMatch(limitRe(DEFAULT_LIMITS.status, "status"))
    }
  })

  it("documents the params the real parsers read and a request example they accept", () => {
    const purchase = find(BUNDLES.purchase)
    expect(purchase.params.map((p) => p.name)).toEqual(["bundle_token", "recipient", "reference", "expected_pay"])
    expect(purchase.params.filter((p) => p.required).map((p) => p.name)).toEqual(["bundle_token", "recipient", "reference"])
    expect(find(BUNDLES.catalog).params.map((p) => p.name)).toEqual(["network"])
    expect(find(BUNDLES.order).params.map((p) => p.name)).toEqual(["reference"])
    expect(find(BUNDLES.list).params).toEqual([])
    for (const sig of [BUNDLES.catalog, BUNDLES.list, BUNDLES.order]) expect(find(sig).requestExample).toBeNull()

    const example = purchase.requestExample as Record<string, unknown>
    expect(Object.keys(example).sort()).toEqual(["bundle_token", "expected_pay", "recipient", "reference"])
    // The example token is a placeholder; with a real signed token the example must pass the real parser.
    const parsed = rules.parseBundlePurchaseBody({ ...example, bundle_token: realToken() })
    expect(parsed.ok).toBe(true)
    // No price-like or network field in the example, and none is accepted by the parser.
    expect(Object.keys(example).join(" ")).not.toMatch(/price|fee|total|cashback|network|amount/i)
    for (const f of ["price", "amount", "network", "face_amount", "pay_amount", "cashback", "status", "user_id"]) {
      expect(rules.parseBundlePurchaseBody({ ...example, bundle_token: realToken(), [f]: 1 }).ok, f).toBe(false)
    }
  })

  it("expected_pay limits in the docs match the parser", () => {
    const desc = find(BUNDLES.purchase).params.find((p) => p.name === "expected_pay")!.description
    expect(desc).toContain("10000")
    const base = { bundle_token: realToken(), recipient: "0244000001", reference: "BND-1" }
    expect(rules.parseBundlePurchaseBody({ ...base, expected_pay: 10000 }).ok).toBe(true)
    expect(rules.parseBundlePurchaseBody({ ...base, expected_pay: 10000.01 }).ok).toBe(false)
  })

  it("the network param text matches the parser's accepted spellings", () => {
    const desc = find(BUNDLES.catalog).params[0].description
    expect(desc).toMatch(/MTN, Telecel, AT or AirtelTigo/)
    for (const n of ["MTN", "Telecel", "AT", "AirtelTigo", "mtn"]) expect(rules.parseBundleNetwork(n).ok, n).toBe(true)
  })

  it("success examples have exactly the mapper allow-list keys", () => {
    const orderKeys = Object.keys(rules.mapBundleOrder({}, "x")).sort()
    expect(orderKeys).toEqual(["bundle", "cashback", "created_at", "face_amount", "network", "paid_amount", "recipient", "reference", "status"])
    const ex = (sig: string) => (find(sig).successExample as { data: any }).data
    expect(Object.keys(ex(BUNDLES.purchase).order).sort()).toEqual(orderKeys)
    expect(Object.keys(ex(BUNDLES.purchase))).toEqual(["order"])
    for (const o of ex(BUNDLES.list).orders) expect(Object.keys(o).sort()).toEqual(orderKeys)
    expect(Object.keys(ex(BUNDLES.order).order).sort()).toEqual(orderKeys)
    expect(ex(BUNDLES.order).claim).toBeNull()
    expect(ex(BUNDLES.purchase).order.reference).toBe((find(BUNDLES.purchase).requestExample as any).reference)

    const cat = ex(BUNDLES.catalog)
    const mapped = rules.mapBundleCatalog("MTN", cat.categories)
    expect(Object.keys(cat).sort()).toEqual(Object.keys(mapped).sort())
    expect(cat.token_valid_seconds).toBe(rules.BUNDLE_CATALOG_VALID_SECONDS)
    expect(JSON.stringify(cat)).toBe(JSON.stringify(mapped))
    // pay_amount = face_amount - customer_cashback in the example.
    for (const c of cat.categories) {
      for (const b of c.bundles) expect(Math.round((b.face_amount - b.customer_cashback) * 100)).toBe(Math.round(b.pay_amount * 100))
    }
    // The purchase example's expected_pay is a pay_amount the catalog example shows.
    const pays = cat.categories.flatMap((c: any) => c.bundles.map((b: any) => b.pay_amount))
    expect(pays).toContain((find(BUNDLES.purchase).requestExample as any).expected_pay)
    expect(ex(BUNDLES.purchase).order.paid_amount).toBe((find(BUNDLES.purchase).requestExample as any).expected_pay)
  })

  it("every documented error message is a real one (exact, or a known number template)", () => {
    const exported = [...Object.values(rules), ...Object.values(bundlesMod)].flatMap((v: unknown) => (typeof v === "string" ? [v] : []))
    const fail = (r: { ok: boolean }): string => (r.ok ? "" : String((r as unknown as { error: string }).error))
    const good = { bundle_token: realToken(), recipient: "0244000001", reference: "BND-1" }
    const parserMsgs = [null, { ...good, price: 1 }, { ...good, bundle_token: "x" }, { ...good, recipient: "1" }, { ...good, reference: "" }, { ...good, expected_pay: -1 }].map((b) =>
      fail(rules.parseBundlePurchaseBody(b))
    )
    parserMsgs.push(fail(rules.parseBundleNetwork("nope")))
    const classified = [
      { status: 400, error: "Enter a valid Ghana mobile number" },
      { status: 400, error: "Invalid request, please try again" },
      { status: 400, error: "x" },
      { status: 402, error: "x" },
      { status: 403, error: "x" },
      { status: 409, error: "Prices refreshed — pick the bundle again" },
      { status: 409, error: "This bundle isn't available for that number right now — refresh" },
      { status: 503, error: "x" },
    ].flatMap((r) => {
      const c = rules.classifyBundleRefusal(r, undefined)
      return c.kind === "no_charge" ? [c.message] : []
    })
    const real = new Set<string>([
      ...exported,
      ...parserMsgs,
      ...classified,
      MSG_UNAUTHORIZED,
      MSG_UNAVAILABLE,
      MSG_RATE_LIMITED,
      MSG_PHONE_GATE,
      MSG_REFERENCE_REUSED,
      MSG_CATALOG_UNAVAILABLE,
      MSG_CLAIM_UNAVAILABLE,
      MSG_SANDBOX_UNAVAILABLE,
      ...access403,
    ])
    const templatePrefixes = ["PRICE_CHANGED: ", "INSUFFICIENT_BALANCE: test balance is too low; required "]
    for (const sig of sigs) {
      for (const err of find(sig).errors) {
        const ok = real.has(err.message) || templatePrefixes.some((p) => err.message.startsWith(p))
        expect(ok, `${sig} documents an unknown message: ${err.message}`).toBe(true)
      }
    }
  })

  it("every no-charge refusal the purchase can return is documented", () => {
    const documented = new Set(find(BUNDLES.purchase).errors.map((e) => e.message))
    const refusals = [
      { status: 400, error: "Enter a valid Ghana mobile number" },
      { status: 400, error: "Invalid request, please try again" },
      { status: 400, error: "x" },
      { status: 402, error: "x" },
      { status: 403, error: "x" },
      { status: 409, error: "Prices refreshed — pick the bundle again" },
      { status: 409, error: "This bundle isn't available for that number right now — refresh" },
      { status: 503, error: "x" },
    ]
    for (const r of refusals) {
      const c = rules.classifyBundleRefusal(r, undefined)
      expect(c.kind).toBe("no_charge")
      if (c.kind === "no_charge") expect(documented.has(c.message), c.message).toBe(true)
    }
    // The documented price-changed message is exactly what the classifier emits for the documented numbers.
    const price = rules.classifyBundleRefusal(
      { status: 409, error: "Price updated — please review", quote: { faceAmount: 5.5, payAmount: 5, customerCashback: 0.5 } },
      5.5
    )
    expect(price.kind === "no_charge" && documented.has(price.message)).toBe(true)
    // Outcome-unknown, in-progress and prior-unknown come from the endpoint module.
    for (const m of [bundlesMod.MSG_BUNDLE_IN_PROGRESS, bundlesMod.MSG_BUNDLE_PRIOR_UNKNOWN, bundlesMod.MSG_BUNDLE_OUTCOME_UNKNOWN, bundlesMod.MSG_SANDBOX_TOKEN_ON_LIVE, bundlesMod.MSG_TOKEN_ON_TEST_KEY]) {
      expect(documented.has(m), m).toBe(true)
    }
    for (const m of [...access403]) expect(documented.has(m)).toBe(true)
    expect(documented.has(MSG_PHONE_GATE)).toBe(true)
  })

  it("the pending-outcome messages never invite a new reference", () => {
    for (const m of [bundlesMod.MSG_BUNDLE_IN_PROGRESS, bundlesMod.MSG_BUNDLE_PRIOR_UNKNOWN, bundlesMod.MSG_BUNDLE_OUTCOME_UNKNOWN]) {
      expect(m).toContain("Do not place this order again under a new reference")
      expect(m).toContain("GET /bundles/orders/{reference}")
    }
  })

  it("limits quoted in the prose match the code", () => {
    const list = find(BUNDLES.list).notes.join(" ")
    expect(list).toContain(`up to ${bundlesMod.BUNDLE_LIST_LIMIT} orders`)
    const catalog = find(BUNDLES.catalog).notes.join(" ")
    expect(catalog).toMatch(/10 minutes/)
    expect(rules.BUNDLE_CATALOG_VALID_SECONDS).toBe(600)
    expect(text(prose("bundles-overview"))).toMatch(/10 minutes/)
  })

  it("the overview explains the flow, idempotency and the traps, and says nothing is coming later", () => {
    const s = prose("bundles-overview")
    const steps = (s.steps ?? []).join(" ")
    for (const path of ["GET /bundles/catalog", "POST /bundles/purchase", "GET /bundles/orders/{reference}"]) expect(steps).toContain(path)
    const t = text(s)
    for (const word of ["bundle_token", "reference", "REFERENCE_REUSED", "REQUEST_IN_PROGRESS", "OUTCOME_UNKNOWN", "BUNDLE_TOKEN_EXPIRED", "PRICE_CHANGED", "expected_pay", "Commission"]) {
      expect(t, word).toContain(word)
    }
    expect(t).toMatch(/404 is not proof/i)
    const everything = v2DocsRegistry.map((x) => text(x)).join(" ") + " " + JSON.stringify(endpoints.map((e) => e.notes))
    expect(everything).not.toMatch(/Standard Bundles?[^.]*(arriving|coming soon|later releases?)/i)
  })

  it("sections are ordered overview, catalog, purchase, orders and sit with the commission group", () => {
    const ids = v2DocsRegistry.map((s) => s.id)
    const at = ["bundles-overview", "bundles-catalog", "bundles-purchase", "bundles-orders"].map((id) => ids.indexOf(id))
    expect(at.every((i) => i >= 0)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
    for (const id of ["bundles-overview", "bundles-catalog", "bundles-purchase", "bundles-orders"]) expect(prose(id).group).toBe("commission")
    // After the airtime and bills sections, before the results checker.
    expect(at[0]).toBeGreaterThan(ids.indexOf("utility-orders"))
    expect(at[3]).toBeLessThan(ids.indexOf("voucher-pins"))
  })

  it("the Start prose names Standard Bundles where it lists the commission key's reach", () => {
    expect(prose("overview").intro).toMatch(/Standard Bundles/)
    expect(prose("authentication").intro).toMatch(/commission key calls the airtime, utility bill and Standard Bundles endpoints/)
    expect(prose("key-types").intro).toMatch(/POST \/bundles\/purchase/)
    expect(prose("sandbox").intro).toMatch(/airtime, bill and Standard Bundle orders/)
    expect(prose("idempotency").intro).toMatch(/Standard Bundle purchases follow the same rules/)
  })
})
