import { describe, it, expect } from "vitest"
import { v2DocsRegistry, V2_BASE_URL } from "./registry"
import { DEFAULT_LIMITS } from "../limits"
import { mapOrder, mapOrderStatus, parseNetwork } from "../data-orders"
import {
  MSG_PACKAGE_NOT_FOUND,
  MSG_NETWORK_MISMATCH,
  MSG_REFERENCE_REUSED,
  MSG_NOT_REGISTERED,
  MSG_ORDER_FAILED,
  MSG_ORDER_NOT_FOUND,
  MSG_LOOKUP_FAILED,
  MSG_UNAVAILABLE as MSG_CATALOG_UNAVAILABLE,
  MSG_PHONE_GATE,
  MSG_NOT_ATTEMPTED,
  BULK_DEADLINE_MS,
} from "../endpoints/data"
import { initialStatus } from "../lifecycle"
import type { V2ErrorStatus } from "../envelope"
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

const VALID_STATUS: V2ErrorStatus[] = [400, 401, 402, 403, 404, 409, 429, 500, 502, 503]
const endpoints = v2DocsRegistry.flatMap((s) => s.endpoints)

describe("v2DocsRegistry", () => {
  it("has unique section ids", () => {
    const ids = v2DocsRegistry.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("has unique endpoint ids", () => {
    const ids = endpoints.map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("documents every endpoint fully", () => {
    for (const e of endpoints) {
      expect(e.summary.length).toBeGreaterThan(0)
      expect(e.rateLimit.length).toBeGreaterThan(0)
      expect(Object.keys(e.successExample).length).toBeGreaterThan(0)
      expect(e.path.startsWith("/")).toBe(true)
      expect(["standard", "commission", "sms"]).toContain(e.keyType)
      for (const err of e.errors) expect(VALID_STATUS).toContain(err.status as V2ErrorStatus)
    }
  })

  it("documents only real access error messages and all variants", () => {
    const real403 = [MSG_SUSPENDED, MSG_PENDING, MSG_REVOKED, msgWrongKeyType("standard"), MSG_ROLE_NOT_ALLOWED]
    for (const sig of ["GET /account/role", "GET /wallet/balance"]) {
      const e = endpoints.find((x) => `${x.method} ${x.path}` === sig)!
      const msgs = (s: number) => e.errors.filter((x) => x.status === s).map((x) => x.message)
      expect(msgs(401)).toEqual([MSG_UNAUTHORIZED])
      expect(MSG_UNAUTHORIZED).toBe("Invalid or missing API key")
      expect(msgs(403).sort()).toEqual([...real403].sort())
      expect(msgs(503)).toEqual([MSG_UNAVAILABLE])
      expect(msgs(429)).toEqual([MSG_RATE_LIMITED])
    }
  })

  it("contains the two live endpoints", () => {
    const sigs = endpoints.map((e) => `${e.method} ${e.path}`)
    expect(sigs).toContain("GET /account/role")
    expect(sigs).toContain("GET /wallet/balance")
  })

  it("has real prose in the Start sections", () => {
    const start = v2DocsRegistry.filter((s) => s.group === "start")
    const ids = start.map((s) => s.id)
    for (const id of ["overview", "authentication", "key-types", "response-format", "errors-and-limits", "idempotency", "sandbox"]) {
      expect(ids).toContain(id)
    }
    for (const s of start) {
      expect(s.endpoints).toEqual([])
      expect((s.intro ?? "").length).toBeGreaterThan(40)
      if (s.steps) {
        expect(s.steps.length).toBeGreaterThan(0)
        s.steps.forEach((x) => expect(x.length).toBeGreaterThan(0))
      }
      if (s.callouts) {
        expect(s.callouts.length).toBeGreaterThan(0)
        s.callouts.forEach((c) => expect(c.body.length).toBeGreaterThan(0))
      }
    }
    const auth = start.find((s) => s.id === "authentication")!
    expect(auth.steps?.length).toBeGreaterThan(0)
    expect(auth.callouts?.some((c) => c.tone === "warning")).toBe(true)
    expect(auth.steps?.[auth.steps.length - 1]).toMatch(/approval/i)
  })

  it("describes key approval exactly as lifecycle.ts implements it", () => {
    const auth = v2DocsRegistry.find((s) => s.id === "authentication")!
    const sandbox = v2DocsRegistry.find((s) => s.id === "sandbox")!
    const authText = [auth.intro ?? "", ...(auth.steps ?? [])].join(" ")
    const allText = v2DocsRegistry
      .map((s) => [s.intro ?? "", ...(s.steps ?? []), ...(s.callouts ?? []).map((c) => c.body)].join(" "))
      .join(" ")

    // Expectations derived from the lifecycle so the docs cannot drift from it.
    expect(initialStatus("live")).toBe("pending")
    expect(initialStatus("test")).toBe("active")
    expect(authText).toMatch(/live keys? (start|starts) (as )?pending/i)
    expect(authText).toMatch(/returns? 403 until Datagod approves/i)
    expect(authText).toMatch(/test .*keys? (are|is) active (immediately|at once)/i)
    expect(sandbox.intro).toMatch(/test keys? (are|is) active (immediately|at once)/i)
    expect(sandbox.intro).toMatch(/no approval/i)

    // Claims that contradict the lifecycle or the UI must not appear anywhere.
    expect(allText).not.toMatch(/usage policy/i)
    expect(allText).not.toMatch(/approved[^.]*independently/i)
    expect(allText).not.toMatch(/a new key starts as pending/i)
  })
})

describe("v2DocsRegistry data endpoints", () => {
  type Ep = (typeof endpoints)[number]
  const find = (sig: string): Ep => endpoints.find((x) => `${x.method} ${x.path}` === sig)!
  const sigs = ["GET /packages", "POST /data/purchase", "POST /data/bulk", "POST /data/verify-number", "GET /orders/{reference}"]
  const msgs = (e: Ep, s: number) => e.errors.filter((x) => x.status === s).map((x) => x.message)
  const allText = JSON.stringify(v2DocsRegistry)
  const access403 = [MSG_SUSPENDED, MSG_PENDING, MSG_REVOKED, msgWrongKeyType("standard"), MSG_ROLE_NOT_ALLOWED]
  const catalog503 = [MSG_UNAVAILABLE, MSG_CATALOG_UNAVAILABLE].sort()
  const limitRe = (n: number, g: string) => new RegExp(`${n} requests per minute \\(${g} group\\)`)

  it("keeps the base URL unchanged", () => {
    expect(V2_BASE_URL).toBe("https://www.datagod.store/api/v2")
  })

  it("documents all five endpoints with rate-limit groups taken from limits.ts", () => {
    for (const sig of sigs) {
      const e = find(sig)
      expect(e, sig).toBeDefined()
      expect(e.keyType).toBe("standard")
      expect(e.group).toBe("data")
      expect(e.notes.length).toBeGreaterThan(0)
    }
    expect(find("POST /data/purchase").rateLimit).toMatch(limitRe(DEFAULT_LIMITS.purchase, "purchase"))
    expect(find("POST /data/bulk").rateLimit).toMatch(limitRe(DEFAULT_LIMITS.bulk, "bulk"))
    for (const sig of ["GET /packages", "POST /data/verify-number", "GET /orders/{reference}"]) {
      expect(find(sig).rateLimit).toMatch(limitRe(DEFAULT_LIMITS.status, "status"))
    }
  })

  it("has params and request examples where applicable", () => {
    expect(find("GET /packages").requestExample).toBeNull()
    expect(find("GET /packages").params.map((p) => p.name)).toEqual(["network", "size_gb"])
    expect(find("GET /orders/{reference}").params.map((p) => p.name)).toEqual(["reference"])
    expect(find("POST /data/purchase").params.map((p) => p.name)).toEqual(["network", "volume_gb", "recipient", "reference"])
    expect(find("POST /data/verify-number").params.map((p) => p.name)).toEqual(["network", "phone"])
    expect(find("POST /data/bulk").params.map((p) => p.name)).toEqual(["orders"])
    for (const sig of ["POST /data/purchase", "POST /data/verify-number", "POST /data/bulk"]) {
      expect(find(sig).requestExample).not.toBeNull()
    }
    expect(JSON.stringify(find("POST /data/purchase").requestExample)).not.toMatch(/price|amount/i)
  })

  it("order examples have exactly mapOrder's key set", () => {
    const keys = Object.keys(
      mapOrder({
        api_reference: "ORD-2026-0001",
        network: "MTN",
        volume_gb: 1,
        price: 5,
        recipient_phone: "0244000001",
        status: "pending",
        created_at: "2026-10-22T09:30:00.000Z",
      })
    ).sort()
    const ex = (sig: string) => (find(sig).successExample as { data: any }).data
    expect(Object.keys(ex("POST /data/purchase").order).sort()).toEqual(keys)
    expect(Object.keys(ex("GET /orders/{reference}").order).sort()).toEqual(keys)
    expect(ex("POST /data/bulk").results.length).toBeGreaterThan(0)
    for (const r of ex("POST /data/bulk").results) {
      if (r.order) expect(Object.keys(r.order).sort()).toEqual(keys)
    }
    expect(ex("POST /data/bulk").skipped[0]).toEqual({ reference: expect.any(String), reason: "NOT_REGISTERED" })
    expect(typeof ex("POST /data/bulk").total_charged).toBe("number")
    expect(typeof ex("POST /data/purchase").new_balance).toBe("number")
    expect(ex("POST /data/verify-number")).toEqual({ allowed: true, checked: true })
    expect(ex("GET /packages").packages.length).toBeGreaterThan(0)
    for (const p of ex("GET /packages").packages) expect(Object.keys(p).sort()).toEqual(["network", "price", "size_gb"])
  })

  it("documented statuses equal mapOrderStatus's output set", () => {
    const section = v2DocsRegistry.find((s) => s.id === "order-statuses")!
    expect(section).toBeDefined()
    expect(section.endpoints).toEqual([])
    const produced = new Set(
      ["pending", "processing", "completed", "failed", "refunded", "held_registration", "garbage", null].map((x) =>
        mapOrderStatus(x)
      )
    )
    expect(produced.size).toBe(6)
    const text = [section.intro ?? "", ...(section.steps ?? [])].join(" ")
    for (const st of produced) expect(text).toContain(st)
    expect(text).toMatch(/queued[^.]*registration/i)
    expect(text).toMatch(/refunded[^.]*wallet/i)
  })

  it("documented networks equal parseNetwork's canonical names", () => {
    const canonical = new Set(
      ["MTN", "Telecel", "AT-iShare", "AT-BigTime", "at - ishare", "AT - BigTime"].map((n) => {
        const r = parseNetwork(n)
        if (!r.ok) throw new Error("unexpected")
        return r.network
      })
    )
    expect([...canonical].sort()).toEqual(["AT-BigTime", "AT-iShare", "MTN", "Telecel"])
    const desc = find("POST /data/purchase").params.find((p) => p.name === "network")!.description
    for (const n of canonical) expect(desc).toContain(n)
    expect(desc).toMatch(/GET \/packages/)
    expect(desc).toMatch(/availab/i)
  })

  it("lists the real error sets using the exported constants", () => {
    const purchase = find("POST /data/purchase")
    expect(msgs(purchase, 401)).toEqual([MSG_UNAUTHORIZED])
    expect(msgs(purchase, 403).sort()).toEqual([...access403, MSG_PHONE_GATE].sort())
    expect(msgs(purchase, 404)).toEqual([MSG_PACKAGE_NOT_FOUND])
    expect(msgs(purchase, 409).sort()).toEqual([MSG_REFERENCE_REUSED, MSG_NOT_REGISTERED].sort())
    expect(msgs(purchase, 429)).toEqual([MSG_RATE_LIMITED])
    expect(msgs(purchase, 500)).toEqual([MSG_ORDER_FAILED])
    expect(msgs(purchase, 503).sort()).toEqual(catalog503)
    expect(msgs(purchase, 402)).toHaveLength(1)
    expect(msgs(purchase, 402)[0]).toMatch(/^INSUFFICIENT_BALANCE: /)
    expect(msgs(purchase, 400)).toContain(MSG_NETWORK_MISMATCH)

    const bulk = find("POST /data/bulk")
    expect(msgs(bulk, 401)).toEqual([MSG_UNAUTHORIZED])
    expect(msgs(bulk, 403).sort()).toEqual([...access403, MSG_PHONE_GATE].sort())
    expect(msgs(bulk, 402)[0]).toMatch(/^INSUFFICIENT_BALANCE: /)
    expect(msgs(bulk, 409)).toEqual([`orders[i]: ${MSG_REFERENCE_REUSED}`])
    expect(msgs(bulk, 500)).toEqual([MSG_LOOKUP_FAILED])
    expect(msgs(bulk, 400).length).toBeGreaterThan(2)
    expect(msgs(bulk, 429)).toEqual([MSG_RATE_LIMITED])
    expect(msgs(bulk, 503).sort()).toEqual(catalog503)

    const verify = find("POST /data/verify-number")
    expect(msgs(verify, 403).sort()).toEqual([...access403].sort())
    expect(msgs(verify, 400).length).toBeGreaterThan(0)
    expect(msgs(verify, 429)).toEqual([MSG_RATE_LIMITED])

    const order = find("GET /orders/{reference}")
    expect(msgs(order, 404)).toEqual([MSG_ORDER_NOT_FOUND])
    expect(msgs(order, 403).sort()).toEqual([...access403].sort())

    const pk = find("GET /packages")
    expect(msgs(pk, 400).length).toBeGreaterThan(0)
    expect(msgs(pk, 503).sort()).toEqual(catalog503)

    for (const e of [purchase, bulk, verify, order, pk]) {
      for (const err of e.errors) expect(VALID_STATUS).toContain(err.status as V2ErrorStatus)
    }
  })

  it("states the money and safety rules in the notes", () => {
    const purchase = find("POST /data/purchase")
    const pn = purchase.notes.join(" ")
    expect(pn).toMatch(/never send a price/i)
    expect(pn).toMatch(/role/i)
    expect(pn).toMatch(/replayed/)
    expect(pn).toMatch(/200/)
    expect(pn).toMatch(/409/)
    expect(pn).toMatch(/phone[^.]*verified/i)
    expect(pn).toContain("PHONE_NOT_VERIFIED")
    expect(pn).toMatch(/not registered[^.]*nothing is charged/i)
    expect(pn).toMatch(/test key[^.]*sandbox/i)
    expect(purchase.params.find((p) => p.name === "recipient")!.description).toMatch(/0244000001/)
    expect(purchase.params.find((p) => p.name === "recipient")!.description).toMatch(/\+233244000001/)
    const bn = find("POST /data/bulk").notes.join(" ")
    expect(bn).toMatch(/skipped/i)
    const deadline = `${BULK_DEADLINE_MS / 1000} seconds`
    expect(bn).toContain(deadline)
    const bulkProse = v2DocsRegistry.find((x) => x.id === "bulk-orders")!
    expect((bulkProse.callouts ?? []).map((c) => c.body).join(" ")).toContain(deadline)
    expect(allText).not.toMatch(/35 seconds/)
    expect(bn).toContain(MSG_NOT_ATTEMPTED)
    expect(bn).toMatch(/test key[^.]*sandbox/i)
    expect(find("GET /packages").notes.join(" ")).toMatch(/availab/i)
    expect(find("GET /orders/{reference}").notes.join(" ")).toMatch(/another account/i)
    expect(find("POST /data/verify-number").notes.join(" ")).toMatch(/test key[^.]*sandbox/i)
  })

  it("has a Bulk orders prose section", () => {
    const s = v2DocsRegistry.find((x) => x.id === "bulk-orders")!
    expect(s).toBeDefined()
    expect(s.endpoints).toEqual([])
    const text = [s.intro ?? "", ...(s.steps ?? []), ...(s.callouts ?? []).map((c) => c.body)].join(" ")
    expect(text).toMatch(/validat/i)
    expect(text).toMatch(/skipped/i)
    expect(text).toMatch(/partial/i)
    expect(text).toContain("NOT_ATTEMPTED")
    expect(text).toMatch(/resend/i)
    expect(text).toMatch(/100/)
  })

  it("does not leak internals in the docs text", () => {
    expect(allText).not.toMatch(/api_v2_key_id|place_api_v2_order|supabase/i)
  })
})
