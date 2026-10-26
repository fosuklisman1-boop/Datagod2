import { describe, it, expect, vi } from "vitest"
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
  BULK_ITEM_ERRORS,
} from "../endpoints/data"
import * as airtimeMod from "../endpoints/airtime"
import * as billsMod from "../endpoints/bills"
import {
  MSG_AIRTIME_NOT_FOUND,
  MSG_REQUEST_IN_PROGRESS,
  MSG_PRIOR_OUTCOME_UNKNOWN,
  MSG_OUTCOME_UNKNOWN,
  MSG_CLAIM_UNAVAILABLE,
  MSG_SANDBOX_UNAVAILABLE,
} from "../endpoints/airtime"
import {
  MSG_BILL_NOT_FOUND,
  MSG_TOKEN_REUSED,
  MSG_BILL_IN_PROGRESS,
  MSG_BILL_PRIOR_UNKNOWN,
  MSG_BILL_OUTCOME_UNKNOWN,
  MSG_BILLS_NOT_AVAILABLE,
  MSG_VERIFY_AGAIN,
  MSG_INVALID_TOKEN,
  MSG_SANDBOX_TOKEN_ON_LIVE,
  MSG_TOKEN_ON_TEST_KEY,
  MSG_INVALID_AMOUNT,
  MSG_PAY_INVALID,
  MSG_INSUFFICIENT,
  MSG_BILLER_UNAVAILABLE,
  MSG_BILLS_UNAVAILABLE,
  MSG_PAY_INTERNAL,
  MSG_LOOKUP_INVALID,
  MSG_LOOKUP_BILLER_UNAVAILABLE,
  MSG_LOOKUP_UNAVAILABLE,
  MSG_LOOKUP_FAILED as MSG_BILL_LOOKUP_FAILED,
  MSG_LOOKUP_INTERNAL,
  MSG_BILLERS_UNAVAILABLE,
  billersHandler,
} from "../endpoints/bills"
import {
  mapAirtimeOrder,
  mapBillOrder,
  mapCommissionStatus,
  mapClaimState,
  parseAirtimeBody,
  parseBillPayBody,
  parseBillLookupBody,
  airtimeErrorResponse,
  NO_CHARGE_ENGINE_CODES,
} from "../commission"
import { CLAIM_STALE_MS } from "../idempotency"
import { BILLER_KEYS } from "@/lib/bills/billers"
import { BILL_LIMIT_CEIL } from "@/lib/bills/config"
import { verifyResponse } from "@/lib/api-v1/bills"
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
      [
        "pending",
        "processing",
        "completed",
        "failed",
        "refunded",
        "held_registration",
        "cancelled",
        "reversed",
        "refunding",
        "garbage",
        null,
      ].map((x) => mapOrderStatus(x))
    )
    expect(produced.size).toBe(6)
    const text = [section.intro ?? "", ...(section.steps ?? [])].join(" ")
    for (const st of produced) expect(text).toContain(st)
    // The docs say how a cancelled order reads, matching the mapper.
    expect(mapOrderStatus("cancelled")).toBe("failed")
    expect(text).toMatch(/cancelled[^.]*failed|failed[^.]*cancelled/i)
    expect(mapOrderStatus("refunding")).toBe("processing")
    expect(text).toMatch(/processing[^.]*refund/i)
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

  it("insufficient funds is documented as 402 everywhere, never 400", () => {
    const wallet = find("GET /wallet/balance")
    expect(wallet.notes.join(" ")).toMatch(/402[^.]*insufficient|insufficient[^.]*402/i)
    // No sentence anywhere pairs 400 with an insufficient balance.
    for (const sentence of allText.split(/[.;]/)) {
      if (/insufficient (wallet )?(balance|funds)/i.test(sentence)) expect(sentence).not.toMatch(/\b400\b/)
    }
    const limits = v2DocsRegistry.find((s) => s.id === "errors-and-limits")!
    expect(limits.intro).toMatch(/402 means[^.]*wallet balance/i)
  })

  it("documents every bulk per-item error value the handler can return", () => {
    expect([...BULK_ITEM_ERRORS].sort()).toEqual(
      ["FAILED", "INSUFFICIENT_BALANCE", "REFERENCE_REUSED", MSG_NOT_ATTEMPTED].sort()
    )
    const bulkNotes = find("POST /data/bulk").notes.join(" ")
    const prose = v2DocsRegistry.find((x) => x.id === "bulk-orders")!
    const proseText = [prose.intro ?? "", ...(prose.callouts ?? []).map((c) => c.body)].join(" ")
    for (const code of BULK_ITEM_ERRORS) {
      expect(bulkNotes + " " + proseText, code).toContain(code)
    }
    expect(proseText).toMatch(/error/i)
  })

  it("says live references are shared with v1 API orders (replay on same content, 409 otherwise)", () => {
    const idem = v2DocsRegistry.find((s) => s.id === "idempotency")!
    expect(idem.intro).toMatch(/version 1[^.]*(same|identical)[^.]*replay[^.]*409/i)
  })

  it("does not leak internals in the docs text", () => {
    expect(allText).not.toMatch(/api_v2_key_id|place_api_v2_order|supabase/i)
  })
})

describe("v2DocsRegistry commission endpoints (airtime and utility bills)", () => {
  type Ep = (typeof endpoints)[number]
  const find = (sig: string): Ep => endpoints.find((x) => `${x.method} ${x.path}` === sig)!
  const msgs = (e: Ep, s: number) => e.errors.filter((x) => x.status === s).map((x) => x.message)
  const text = (s: { intro?: string; steps?: string[]; callouts?: { body: string; title?: string }[] }) =>
    [s.intro ?? "", ...(s.steps ?? []), ...(s.callouts ?? []).flatMap((c) => [c.title ?? "", c.body])].join(" ")
  const prose = (id: string) => v2DocsRegistry.find((s) => s.id === id)!
  const AIRTIME = {
    purchase: "POST /airtime/purchase",
    list: "GET /airtime/orders",
    order: "GET /airtime/orders/{reference}",
  }
  const BILLS = {
    billers: "GET /utilities/billers",
    lookup: "POST /utilities/lookup",
    pay: "POST /utilities/pay",
    order: "GET /utilities/orders/{reference}",
  }
  const sigs = [...Object.values(AIRTIME), ...Object.values(BILLS)]
  const access403 = [MSG_SUSPENDED, MSG_PENDING, MSG_REVOKED, msgWrongKeyType("commission"), MSG_ROLE_NOT_ALLOWED]
  const limitRe = (n: number, g: string) => new RegExp(`${n} requests per minute \\(${g} group\\)`)

  // Every message the real handlers and parsers can emit, derived from the code.
  const exported: string[] = [...Object.values(airtimeMod), ...Object.values(billsMod)].flatMap((v: unknown) => (typeof v === "string" ? [v] : []))
  const failMsg = (r: { ok: boolean }): string => (r.ok ? "" : String((r as unknown as { error: string }).error))
  const parserMsgs = (): string[] => {
    const good = { network: "MTN", recipient: "0244000001", amount: 10, reference: "AIR-2026-0001" }
    const out = [null, { ...good, price: 1 }, { ...good, network: "x" }, { ...good, recipient: "1" }, { ...good, amount: 0 }, { ...good, reference: "" }, { ...good, expected_pay: -1 }].map(
      (b) => failMsg(parseAirtimeBody(b))
    )
    const pay = { verify_token: "tok-1234567890", amount: 50, reference: "BILL-2026-0001" }
    for (const b of [null, { ...pay, price: 1 }, { ...pay, verify_token: "x" }, { ...pay, amount: 0 }, { ...pay, reference: "" }, { ...pay, expected_pay: -1 }]) {
      out.push(failMsg(parseBillPayBody(b)))
    }
    out.push(failMsg(parseBillLookupBody(null)), failMsg(parseBillLookupBody({ biller: "nope" })))
    return out
  }
  const realMessages = new Set<string>([
    ...exported,
    ...parserMsgs(),
    ...["NETWORK_DISABLED", "NETWORK_MISMATCH", "INVALID_AMOUNT", "DUPLICATE_REQUEST"].map((c) => {
      const r = airtimeErrorResponse({ code: c })
      return `${r.code}: ${r.message}`
    }),
    MSG_UNAUTHORIZED,
    MSG_UNAVAILABLE,
    MSG_RATE_LIMITED,
    MSG_PHONE_GATE,
    MSG_REFERENCE_REUSED,
    MSG_CATALOG_UNAVAILABLE,
    ...access403,
  ])
  // Messages that carry a number or a code from the engine and so are templates.
  const templatePrefixes = [
    "INSUFFICIENT_BALANCE: wallet balance is too low; required ",
    "INSUFFICIENT_BALANCE: test balance is too low; required ",
    "PRICE_CHANGED: ",
    "NETWORK_MISMATCH: ",
    "NETWORK_DISABLED: ",
    "DUPLICATE_REQUEST: ",
  ]
  const engineMsg = (code: string) => {
    const r = airtimeErrorResponse({ code })
    return `${r.code}: ${r.message}`
  }

  it("documents all seven endpoints with key type commission in the commission group", () => {
    for (const sig of sigs) {
      const e = find(sig)
      expect(e, sig).toBeDefined()
      expect(e.keyType).toBe("commission")
      expect(e.group).toBe("commission")
      expect(e.notes.length).toBeGreaterThan(0)
      expect(e.summary.length).toBeGreaterThan(20)
    }
    expect(sigs).toHaveLength(7)
  })

  it("takes rate-limit strings from limits.ts and says lookup and pay share the purchase group", () => {
    expect(find(AIRTIME.purchase).rateLimit).toMatch(limitRe(DEFAULT_LIMITS.purchase, "purchase"))
    expect(find(BILLS.lookup).rateLimit).toMatch(limitRe(DEFAULT_LIMITS.purchase, "purchase"))
    expect(find(BILLS.pay).rateLimit).toMatch(limitRe(DEFAULT_LIMITS.purchase, "purchase"))
    for (const sig of [AIRTIME.list, AIRTIME.order, BILLS.billers, BILLS.order]) {
      expect(find(sig).rateLimit).toMatch(limitRe(DEFAULT_LIMITS.status, "status"))
    }
    for (const sig of [BILLS.lookup, BILLS.pay]) {
      expect(find(sig).rateLimit).toMatch(/share/i)
      expect(find(sig).notes.join(" ")).toMatch(/shar[^.]*(lookup|pay)[^.]*(five|5)[^.]*per minute/i)
    }
    // "about five" is only true while lookup + pay each cost one purchase-group request.
    expect(DEFAULT_LIMITS.purchase / 2).toBe(5)
  })

  it("documents params and request examples that the real parsers accept", () => {
    expect(find(AIRTIME.purchase).params.map((p) => p.name)).toEqual(["network", "recipient", "amount", "reference", "expected_pay"])
    expect(find(AIRTIME.purchase).params.filter((p) => p.required).map((p) => p.name)).toEqual(["network", "recipient", "amount", "reference"])
    expect(find(AIRTIME.order).params.map((p) => p.name)).toEqual(["reference"])
    expect(find(BILLS.order).params.map((p) => p.name)).toEqual(["reference"])
    expect(find(AIRTIME.list).params).toEqual([])
    expect(find(BILLS.billers).params).toEqual([])
    expect(find(BILLS.lookup).params.map((p) => p.name)).toEqual(["biller", "account", "phone", "email", "broadband_account", "add_meter"])
    expect(find(BILLS.lookup).params.filter((p) => p.required).map((p) => p.name)).toEqual(["biller"])
    expect(find(BILLS.pay).params.map((p) => p.name)).toEqual(["verify_token", "amount", "reference", "expected_pay"])
    expect(find(BILLS.pay).params.filter((p) => p.required).map((p) => p.name)).toEqual(["verify_token", "amount", "reference"])

    for (const sig of [AIRTIME.list, AIRTIME.order, BILLS.billers, BILLS.order]) expect(find(sig).requestExample).toBeNull()
    expect(parseAirtimeBody(find(AIRTIME.purchase).requestExample).ok).toBe(true)
    expect(find(BILLS.lookup).requestExample).not.toBeNull()
    expect(parseBillLookupBody(find(BILLS.lookup).requestExample).ok).toBe(true)
    expect(parseBillPayBody(find(BILLS.pay).requestExample).ok).toBe(true)
    // No price-like fields in any request example.
    for (const sig of [AIRTIME.purchase, BILLS.pay]) {
      expect(Object.keys(find(sig).requestExample as object).join(" ")).not.toMatch(/price|fee|total|cashback/i)
    }
    // The limits in the param text come from the parsers.
    expect(find(AIRTIME.purchase).params.find((p) => p.name === "amount")!.description).toContain("1000")
    expect(find(BILLS.pay).params.find((p) => p.name === "amount")!.description).toContain(String(BILL_LIMIT_CEIL))
    expect(find(BILLS.pay).params.find((p) => p.name === "verify_token")!.description).toMatch(/single-use|pays one/i)
    expect(find(AIRTIME.purchase).params.find((p) => p.name === "network")!.description).toMatch(/AirtelTigo/)
  })

  it("order examples have exactly the mapper allow-list keys", () => {
    const airKeys = Object.keys(mapAirtimeOrder({}, "x")).sort()
    const billKeys = Object.keys(mapBillOrder({}, "x")).sort()
    expect(airKeys).toEqual(["airtime_amount", "cashback", "created_at", "fee_amount", "network", "recipient", "reference", "status", "total_paid"])
    expect(billKeys).toEqual(["account", "biller", "cashback", "created_at", "customer_name", "face_amount", "paid_amount", "reference", "status"])
    const ex = (sig: string) => (find(sig).successExample as { data: any }).data
    expect(Object.keys(ex(AIRTIME.purchase).order).sort()).toEqual(airKeys)
    expect(typeof ex(AIRTIME.purchase).new_balance).toBe("number")
    expect(ex(AIRTIME.list).orders.length).toBeGreaterThan(0)
    for (const o of ex(AIRTIME.list).orders) expect(Object.keys(o).sort()).toEqual(airKeys)
    expect(Object.keys(ex(AIRTIME.order).order).sort()).toEqual(airKeys)
    expect(ex(AIRTIME.order).claim).toBeNull()
    expect(Object.keys(ex(BILLS.pay).order).sort()).toEqual(billKeys)
    expect(Object.keys(ex(BILLS.order).order).sort()).toEqual(billKeys)
    expect(ex(BILLS.order).claim).toBeNull()
    expect(ex(AIRTIME.purchase).order.reference).toBe("AIR-2026-0001")
    expect(ex(BILLS.pay).order.reference).toBe("BILL-2026-0001")
    expect(ex(AIRTIME.purchase).order.recipient).toMatch(/^024/)
    // The status in every example is a value the mapper can produce.
    for (const o of [ex(AIRTIME.purchase).order, ex(BILLS.pay).order]) expect(mapCommissionStatus(o.status)).toBe(o.status)
  })

  it("the lookup example has verifyResponse's keys (minus success) and the billers example matches billersHandler", async () => {
    const real = Object.keys(verifyResponse({ customerName: "A", amountDue: 1, suggestedAmount: 1, token: "t" }))
      .filter((k) => k !== "success")
      .sort()
    const lookup = (find(BILLS.lookup).successExample as { data: any }).data
    expect(Object.keys(lookup).sort()).toEqual(real)
    const meters = Object.keys(
      verifyResponse({ customerName: null, amountDue: null, suggestedAmount: 0, meters: [{ meter: "m", name: "n", outstanding: 1, token: "t" }] }).meters![0]
    ).sort()
    expect(meters).toEqual(["meter", "name", "outstanding", "verify_token"])
    const lookupNotes = find(BILLS.lookup).notes.join(" ")
    for (const k of meters) expect(lookupNotes).toContain(k)
    expect(lookupNotes).toContain("meters")

    const billers = (find(BILLS.billers).successExample as { data: { billers: any[] } }).data.billers
    expect(billers.map((b) => b.key)).toEqual([...BILLER_KEYS])
    const cfg = {
      enabled: true,
      autoFulfil: true,
      billers: Object.fromEntries(billers.map((b) => [b.key, { enabled: b.enabled, min: b.min_amount, max: b.max_amount }])),
    }
    const handled = await billersHandler({ getBillsConfig: async () => cfg } as any)({} as any)
    expect((handled.data as any).billers).toEqual(billers)
  })

  it("lists every status the handlers can return, from mapCommissionStatus", () => {
    const produced = new Set(
      ["pending", "pending_payment", "processing", "completed", "failed", "refunded", "weird", null, 7].map((x) => mapCommissionStatus(x))
    )
    expect([...produced].sort()).toEqual(["completed", "failed", "pending", "processing", "refunded"])
    for (const sig of [AIRTIME.order, BILLS.order]) {
      const n = find(sig).notes.join(" ")
      for (const st of produced) expect(n, `${sig} ${st}`).toContain(st)
    }
  })

  it("documents the claim lookup shape with the real claim states and stale window", () => {
    const states = new Set<string>()
    const now = Date.parse("2026-10-24T12:00:00.000Z")
    for (const c of [
      { status: "unknown" },
      { status: "in_progress", createdAt: new Date(now - 1000).toISOString() },
      { status: "in_progress", createdAt: new Date(now - CLAIM_STALE_MS - 1).toISOString() },
    ]) {
      const r = mapClaimState(c, "R-1", now)
      if (r) states.add(r.state)
    }
    expect([...states].sort()).toEqual(["in_progress", "outcome_unknown"])
    for (const sig of [AIRTIME.order, BILLS.order]) {
      const e = find(sig)
      const n = e.notes.join(" ")
      expect(n).toContain("claim.state")
      for (const st of states) expect(n, sig).toContain(st)
      expect(n).toMatch(/HTTP 200/)
      expect(n).toMatch(/order: null/)
      expect(n).toMatch(/identical 404/i)
      expect(n).toMatch(new RegExp(`${CLAIM_STALE_MS / 60000} minutes`))
      expect(msgs(e, 404)).toEqual([sig === AIRTIME.order ? MSG_AIRTIME_NOT_FOUND : MSG_BILL_NOT_FOUND])
    }
  })

  it("lists the real error set for airtime purchase", () => {
    const e = find(AIRTIME.purchase)
    expect(msgs(e, 401)).toEqual([MSG_UNAUTHORIZED])
    expect(msgs(e, 403).sort()).toEqual([...access403, MSG_PHONE_GATE].sort())
    expect(msgs(e, 429)).toEqual([MSG_RATE_LIMITED])
    expect(msgs(e, 402)[0]).toMatch(/^INSUFFICIENT_BALANCE: wallet balance is too low; required \d+\.\d{2}$/)
    expect(msgs(e, 400)).toEqual(
      expect.arrayContaining([failMsg(parseAirtimeBody(null)), "Unexpected field", engineMsg("NETWORK_MISMATCH"), engineMsg("INVALID_AMOUNT")])
    )
    const m409 = msgs(e, 409)
    for (const m of [MSG_REFERENCE_REUSED, MSG_REQUEST_IN_PROGRESS, MSG_PRIOR_OUTCOME_UNKNOWN, engineMsg("DUPLICATE_REQUEST")]) expect(m409).toContain(m)
    expect(m409.some((m) => m.startsWith("PRICE_CHANGED: the price has changed; face_amount "))).toBe(true)
    expect(msgs(e, 500)).toEqual(expect.arrayContaining([MSG_OUTCOME_UNKNOWN, MSG_SANDBOX_UNAVAILABLE]))
    expect(msgs(e, 503)).toEqual(expect.arrayContaining([engineMsg("NETWORK_DISABLED"), MSG_CLAIM_UNAVAILABLE, MSG_UNAVAILABLE]))
    expect(msgs(e, 502)).toEqual([])
  })

  it("lists the real error sets for the airtime reads", () => {
    for (const sig of [AIRTIME.list, AIRTIME.order]) {
      const e = find(sig)
      expect(msgs(e, 401)).toEqual([MSG_UNAUTHORIZED])
      expect(msgs(e, 403).sort()).toEqual([...access403].sort())
      expect(msgs(e, 429)).toEqual([MSG_RATE_LIMITED])
      expect(msgs(e, 500)).toEqual([MSG_SANDBOX_UNAVAILABLE])
    }
    expect(msgs(find(AIRTIME.list), 503)).toEqual(expect.arrayContaining([MSG_UNAVAILABLE, MSG_CATALOG_UNAVAILABLE]))
    expect(msgs(find(AIRTIME.list), 404)).toEqual([])
  })

  it("lists the real error sets for the bills endpoints", () => {
    const billersE = find(BILLS.billers)
    expect(msgs(billersE, 403).sort()).toEqual([...access403].sort())
    expect(msgs(billersE, 503)).toEqual(expect.arrayContaining([MSG_BILLERS_UNAVAILABLE, MSG_UNAVAILABLE]))

    const lookup = find(BILLS.lookup)
    expect(msgs(lookup, 403).sort()).toEqual([...access403, MSG_BILLS_NOT_AVAILABLE].sort())
    expect(msgs(lookup, 400)).toEqual(
      expect.arrayContaining([failMsg(parseBillLookupBody(null)), failMsg(parseBillLookupBody({ biller: "nope" })), MSG_LOOKUP_INVALID])
    )
    expect(msgs(lookup, 502)).toEqual([MSG_BILL_LOOKUP_FAILED])
    expect(msgs(lookup, 500)).toEqual([MSG_LOOKUP_INTERNAL])
    expect(msgs(lookup, 503)).toEqual(expect.arrayContaining([MSG_LOOKUP_BILLER_UNAVAILABLE, MSG_LOOKUP_UNAVAILABLE, MSG_UNAVAILABLE]))
    expect(msgs(lookup, 429)).toEqual([MSG_RATE_LIMITED])

    const pay = find(BILLS.pay)
    expect(msgs(pay, 401)).toEqual([MSG_UNAUTHORIZED])
    expect(msgs(pay, 403).sort()).toEqual([...access403, MSG_PHONE_GATE, MSG_BILLS_NOT_AVAILABLE].sort())
    expect(msgs(pay, 402)).toEqual(expect.arrayContaining([MSG_INSUFFICIENT]))
    expect(MSG_INSUFFICIENT).toMatch(/Verify the account again after topping up/)
    expect(msgs(pay, 400)).toEqual(
      expect.arrayContaining([
        "Unexpected field",
        "verify_token is required",
        MSG_INVALID_TOKEN,
        MSG_SANDBOX_TOKEN_ON_LIVE,
        MSG_TOKEN_ON_TEST_KEY,
        MSG_INVALID_AMOUNT,
        MSG_PAY_INVALID,
      ])
    )
    const m409 = msgs(pay, 409)
    for (const m of [MSG_REFERENCE_REUSED, MSG_BILL_IN_PROGRESS, MSG_BILL_PRIOR_UNKNOWN, MSG_TOKEN_REUSED, MSG_VERIFY_AGAIN]) expect(m409).toContain(m)
    expect(m409.some((m) => /^PRICE_CHANGED: expected \d+\.\d{2}, current \d+\.\d{2} \(face_amount /.test(m))).toBe(true)
    expect(msgs(pay, 500)).toEqual(expect.arrayContaining([MSG_BILL_OUTCOME_UNKNOWN, MSG_PAY_INTERNAL, MSG_SANDBOX_UNAVAILABLE]))
    expect(msgs(pay, 503)).toEqual(
      expect.arrayContaining([MSG_BILLER_UNAVAILABLE, MSG_BILLS_UNAVAILABLE, MSG_CLAIM_UNAVAILABLE, MSG_UNAVAILABLE])
    )
    expect(msgs(pay, 429)).toEqual([MSG_RATE_LIMITED])

    const order = find(BILLS.order)
    expect(msgs(order, 403).sort()).toEqual([...access403].sort())
    expect(msgs(order, 500)).toEqual([MSG_SANDBOX_UNAVAILABLE])
  })

  it("documents only messages the code can produce, and names the commission key in 403", () => {
    for (const sig of sigs) {
      const e = find(sig)
      for (const err of e.errors) {
        expect(VALID_STATUS).toContain(err.status as V2ErrorStatus)
        const real = realMessages.has(err.message) || templatePrefixes.some((p) => err.message.startsWith(p))
        expect(real, `${sig} ${err.status} ${err.message}`).toBe(true)
      }
      expect(msgs(e, 403)).toContain(msgWrongKeyType("commission"))
      expect(msgs(e, 403)).not.toContain(msgWrongKeyType("standard"))
      expect(msgs(e, 401)).toEqual([MSG_UNAUTHORIZED])
      expect(msgs(e, 429)).toEqual([MSG_RATE_LIMITED])
    }
    // Machine codes named by the brief exist in the handler constants and are documented.
    const all = sigs.flatMap((s) => find(s).errors.map((x) => x.message)).join(" ")
    for (const c of ["REFERENCE_REUSED", "REQUEST_IN_PROGRESS", "OUTCOME_UNKNOWN", "PHONE_NOT_VERIFIED", "VERIFY_AGAIN", "PRICE_CHANGED"]) {
      expect(all, c).toContain(c + ":")
      expect([...exported, MSG_PHONE_GATE, MSG_REFERENCE_REUSED, engineMsg("PRICE_CHANGED")].some((m) => m.startsWith(c + ":")), c).toBe(true)
    }
    expect(MSG_REQUEST_IN_PROGRESS).toMatch(/Do not place this order again under a new reference/)
  })

  it("states replay, safety and sandbox rules in the notes", () => {
    for (const sig of [AIRTIME.purchase, BILLS.pay]) {
      const n = find(sig).notes.join(" ")
      expect(n, sig).toMatch(/HTTP 200[^.]*replayed: true/)
      expect(n, sig).toMatch(/not charged a second time/i)
      expect(n, sig).toMatch(/HTTP 201/)
      expect(n, sig).toMatch(/test key[^.]*sandbox/i)
      expect(n, sig).toMatch(/new reference/i)
      expect(n, sig).toContain("PHONE_NOT_VERIFIED")
    }
    const pn = find(AIRTIME.purchase).notes.join(" ")
    expect(pn).toMatch(/expected_pay/)
    expect(pn).toMatch(/never send a price/i)
    const bn = find(BILLS.pay).notes.join(" ")
    expect(bn).toMatch(/one verification pays one reference/i)
    expect(bn).toMatch(/VERIFY_AGAIN/)
    expect(bn).toMatch(/top(ping)? up/i)
    expect(bn).toMatch(/sandbox verify_token[^.]*test key|test key[^.]*sandbox verify_token/i)
    expect(bn).toMatch(/live key[^.]*400|400[^.]*live key/i)
    const ln = find(BILLS.lookup).notes.join(" ")
    expect(ln).toMatch(/moves no money/i)
    expect(ln).toMatch(/sandbox/i)
    // Lookup input requirements follow the biller list.
    expect(ln).toMatch(/ecg[^.]*phone/i)
    expect(ln).toMatch(/ghana_water[^.]*account[^.]*phone[^.]*email/i)
    expect(ln).toMatch(/dstv[^.]*gotv|gotv[^.]*dstv/i)
    expect(ln).toMatch(/startimes/i)
    expect(ln).toMatch(/telecel_broadband[^.]*broadband_account/i)
    expect(find(BILLS.billers).notes.join(" ")).toMatch(/min_amount[^.]*max_amount/)
  })

  it("has the Idempotency and references (airtime and bills) section", () => {
    const s = prose("commission-idempotency")
    expect(s).toBeDefined()
    expect(s.group).toBe("commission")
    expect(s.endpoints).toEqual([])
    expect(s.label).toBe("Idempotency and references (airtime and bills)")
    const t = text(s)
    expect(t).toMatch(/required/i)
    expect(t).toMatch(/3 to 100/)
    for (const code of ["REFERENCE_REUSED", "REQUEST_IN_PROGRESS", "OUTCOME_UNKNOWN", "replayed: true"]) expect(t, code).toContain(code)
    expect(t).toMatch(/new reference/i)
    expect(t).toMatch(/never/i)
    expect(t).toContain("claim.state")
    expect(t).toMatch(/support[^.]*reference|reference[^.]*support/i)
    expect(t).toMatch(/200/)
    expect(t).toMatch(/503/)
    const warn = (s.callouts ?? []).find((c) => c.tone === "warning")
    expect(warn).toBeDefined()
    expect(warn!.body).toMatch(/404/)
    expect(warn!.body).toMatch(/not charged|never means/i)
    expect(warn!.body).toMatch(/outcome/i)
  })

  it("has the Airtime pricing section", () => {
    const s = prose("airtime-pricing")
    expect(s).toBeDefined()
    expect(s.group).toBe("commission")
    expect(s.endpoints).toEqual([])
    const t = text(s)
    for (const k of ["total_paid", "fee_amount", "cashback", "expected_pay"]) expect(t, k).toContain(k)
    expect(t).toMatch(/role/i)
    expect(t).toMatch(/no fixed|not (a )?fixed|does not (fix|guarantee)/i)
    expect(t).toMatch(/409/)
    expect(t).toContain("PRICE_CHANGED")
  })

  it("has the Bill payment flow section", () => {
    const s = prose("bill-payment-flow")
    expect(s).toBeDefined()
    expect(s.group).toBe("commission")
    expect(s.endpoints).toEqual([])
    expect((s.steps ?? []).length).toBeGreaterThanOrEqual(3)
    const steps = (s.steps ?? []).join(" ")
    expect(steps).toContain("GET /utilities/billers")
    expect(steps).toContain("POST /utilities/lookup")
    expect(steps).toContain("POST /utilities/pay")
    expect(steps).toContain("verify_token")
    const t = text(s)
    expect(t).toMatch(/one verification pays one reference/i)
    expect(t).toContain("VERIFY_AGAIN")
    expect(t).toContain("PRICE_CHANGED")
    expect(t).toMatch(/409/)
    expect(t).toMatch(/402/)
    expect(t).toMatch(/top(ping)? up/i)
  })

  it("updates the Start prose: commission keys unlock airtime and bills, nothing says they are coming later", () => {
    expect(prose("key-types").intro).toMatch(/Commission Services keys unlock airtime and utility bill/)
    const auth = prose("authentication")
    expect(text(auth)).toMatch(/commission/i)
    expect(text(auth)).toMatch(/airtime/i)
    const overview = prose("overview")
    expect(overview.intro).toMatch(/airtime/i)
    expect(overview.intro).toMatch(/utility bills/i)
    const everything = v2DocsRegistry.map((s) => text(s)).join(" ") + " " + JSON.stringify(endpoints.map((e) => e.notes))
    expect(everything).not.toMatch(/(airtime|utility bills?)[^.]*(arriving|coming|later releases?|soon)/i)
    expect(everything).not.toMatch(/(arriving|coming|later releases?|soon)[^.]*(airtime|utility bills?)/i)
    // The Sandbox and Idempotency prose cover the commission endpoints too.
    expect(prose("sandbox").intro).toMatch(/airtime/i)
    expect(prose("sandbox").intro).toMatch(/verify_token/)
    expect(prose("idempotency").intro).toMatch(/Idempotency and references \(airtime and bills\)/)
    expect(prose("idempotency").intro).not.toMatch(/even if other values changed/i)
    expect(prose("errors-and-limits").intro).toMatch(/502/)
  })

  // ---------------------------------------------------------------- fix wave 2 (pricing, wording, drift)

  const cents = (n: number) => Math.round(n * 100)

  it("the airtime order example is the legacy (no-cashback) path: total_paid = airtime_amount + fee_amount, expected_pay = total_paid", () => {
    const purchase = find(AIRTIME.purchase)
    const order = (purchase.successExample as { data: any }).data.order
    expect(order.airtime_amount).toBe(10)
    expect(order.fee_amount).toBe(0.5)
    expect(order.total_paid).toBe(10.5)
    expect(cents(order.total_paid)).toBe(cents(order.airtime_amount) + cents(order.fee_amount))
    expect(order.cashback).toBe(0)
    expect((purchase.requestExample as any).expected_pay).toBe(order.total_paid)
    expect((purchase.requestExample as any).amount).toBe(order.airtime_amount)
    // The 402 example asks for the same total.
    expect(msgs(purchase, 402)).toContain(`INSUFFICIENT_BALANCE: wallet balance is too low; required ${order.total_paid.toFixed(2)}`)
    for (const sig of [AIRTIME.list, AIRTIME.order]) {
      const d = (find(sig).successExample as { data: any }).data
      const o = d.orders ? d.orders[0] : d.order
      expect(cents(o.total_paid)).toBe(cents(o.airtime_amount) + cents(o.fee_amount))
    }
  })

  it("the airtime PRICE_CHANGED example is the cashback path: pay_amount = face_amount - customer_cashback", () => {
    const m = msgs(find(AIRTIME.purchase), 409).find((x) => x.startsWith("PRICE_CHANGED:"))!
    const g = /face_amount (\d+\.\d{2}), pay_amount (\d+\.\d{2}), customer_cashback (\d+\.\d{2})/.exec(m)
    expect(g).not.toBeNull()
    const [face, pay, cb] = [Number(g![1]), Number(g![2]), Number(g![3])]
    expect(cb).toBeGreaterThan(0)
    expect(cents(pay)).toBe(cents(face) - cents(cb))
  })

  it("the Airtime pricing prose explains both paths, expected_pay as the total, and the sandbox price", () => {
    const t = text(prose("airtime-pricing"))
    expect(t).toMatch(/cashback[^.]*applied[^.]*face value minus[^.]*cashback/i)
    expect(t).toMatch(/otherwise[^.]*face value plus[^.]*fee/i)
    expect(t).toMatch(/recipient (always )?(gets|receives) the full face value/i)
    expect(t).toMatch(/expected_pay[^.]*total you expect to be charged/i)
    expect(t).toMatch(/sandbox[^.]*face value[^.]*no fee[^.]*no cashback/i)
    const pn = find(AIRTIME.purchase).notes.join(" ")
    expect(pn).toMatch(/face value with no fee and no cashback/i)
  })

  it("DUPLICATE_REQUEST is documented with the real message, which never invites a resend under a new reference", () => {
    const real = engineMsg("DUPLICATE_REQUEST")
    expect(real).not.toMatch(/wait before trying again/i)
    expect(real).toMatch(/identical airtime order was just placed/i)
    expect(real).toMatch(/original reference/i)
    expect(real).toMatch(/do not resend it under a new reference unless you intend a second identical order/i)
    expect(msgs(find(AIRTIME.purchase), 409)).toContain(real)
    expect(JSON.stringify(v2DocsRegistry)).not.toMatch(/wait before trying again/i)
  })

  it("references are per ACCOUNT (never 'by your key'), and support investigates rather than promising a provider resolution", () => {
    expect(JSON.stringify(v2DocsRegistry)).not.toMatch(/(used|reference)[^."]*by your key/i)
    const t = text(prose("commission-idempotency"))
    expect(t).toMatch(/never used by your account/i)
    expect(t).not.toMatch(/resolves it against the provider/i)
    expect(t).toMatch(/support will investigate the reference you quote/i)
  })

  it("explains that sandbox references are unique per account across all order types (live: per type)", () => {
    for (const t of [text(prose("commission-idempotency")), prose("sandbox").intro ?? ""]) {
      expect(t).toMatch(/sandbox references are unique per account across all order types/i)
      expect(t).toMatch(/live references are unique per order type/i)
      expect(t).toMatch(/distinct prefix/i)
    }
  })

  // Bidirectional drift: the SET of documented error statuses equals the set the real handler
  // produces (driven through every branch with fakes), plus the access layer's statuses.
  const ACCESS_STATUSES = [401, 403, 429, 503] // runV2: unauthorized, decideAccess 403s, rate limit, disabled/degraded
  const docStatuses = (sig: string) => [...new Set(find(sig).errors.map((e) => e.status))].sort()
  const LIVE_CTX = { keyId: "k", userId: "u", role: "dealer", keyType: "commission", environment: "live", firstName: null }
  const TEST_CTX = { ...LIVE_CTX, environment: "test" }
  const quiet = () => vi.spyOn(console, "error").mockImplementation(() => {})

  it("airtime purchase: documented statuses == statuses the handler produces", async () => {
    const spy = quiet()
    const produced = new Set<number>(ACCESS_STATUSES)
    const sandbox = { getOrder: async () => null, listOrders: async () => [], place: async () => ({ success: false, error: "x", status: 402 }) }
    const base = () => ({
      claim: async () => ({ kind: "claimed", claimId: "c1" }),
      complete: async () => true,
      release: async () => true,
      markUnknown: async () => true,
      getClaim: async () => null,
      listClaims: async () => [],
      alert: async () => {},
      engine: async () => {
        throw new Error("x")
      },
      getOrderByCode: async () => null,
      getOrdersByCodes: async () => [],
      phoneGate: async () => true,
      sandbox,
      now: () => 0,
    })
    const good = { network: "MTN", recipient: "0244000001", amount: 10, reference: "AIR-2026-0001" }
    const run = async (over: object, b: unknown = good, ctx: object = LIVE_CTX) => {
      const r = await airtimeMod.purchaseAirtimeHandler({ ...base(), ...over } as any)(b, ctx as any)
      if (r.error) produced.add(r.status)
    }
    await run({}, null)
    for (const kind of ["conflict", "in_progress", "unknown", "error"]) await run({ claim: async () => ({ kind }) })
    await run({ phoneGate: async () => false })
    for (const code of [...NO_CHARGE_ENGINE_CODES, "PAYMENT_FAILED", "ORDER_CREATE_FAILED", undefined]) {
      await run({
        engine: async () => {
          throw Object.assign(new Error("x"), { code })
        },
      })
    }
    await run({}, good, TEST_CTX)
    await run({ sandbox: { ...sandbox, place: async () => ({ success: false, error: "x", status: 500 }) } }, good, TEST_CTX)
    spy.mockRestore()
    expect(docStatuses(AIRTIME.purchase)).toEqual([...produced].sort())
  })

  it("bill pay: documented statuses == statuses the handler produces", async () => {
    const spy = quiet()
    const produced = new Set<number>(ACCESS_STATUSES)
    const refused = (status: number, extra: object = {}) => async () => ({ result: { ok: false, status, error: "x", ...extra }, fresh: true })
    const base = () => ({
      claim: async () => ({ kind: "claimed", claimId: "c1" }),
      complete: async () => true,
      release: async () => true,
      markUnknown: async () => true,
      getClaim: async () => null,
      findClaimByOrderRef: async () => [],
      surfaceOpen: async () => true,
      phoneGate: async () => true,
      getBillsConfig: async () => ({}),
      verify: async () => ({ ok: false, status: 400, error: "x" }),
      pay: refused(400),
      getOrderByCode: async () => null,
      sandbox: { getOrder: async () => null, findByTokenRef: async () => [], place: async () => ({ success: false, error: "x", status: 402 }) },
      now: () => 0,
    })
    const good = { verify_token: "tok-1234567890", amount: 50, reference: "BILL-2026-0001" }
    const run = async (over: object, b: unknown = good, ctx: object = LIVE_CTX) => {
      const r = await billsMod.billPayHandler({ ...base(), ...over } as any)(b, ctx as any)
      if (r.error) produced.add(r.status)
    }
    await run({}, null)
    await run({}, { ...good, verify_token: "sandbox_bill.abcdefghij" })
    for (const kind of ["conflict", "in_progress", "unknown", "error"]) await run({ claim: async () => ({ kind }) })
    await run({ surfaceOpen: async () => false })
    await run({ phoneGate: async () => false })
    for (const s of [400, 402, 403, 409, 422, 503, 500]) await run({ pay: refused(s) })
    await run({ pay: refused(409, { quote: { faceAmount: 50, payAmount: 50.5, customerCashback: 0.5 } }) })
    await run({
      pay: async () => {
        throw new Error("x")
      },
    })
    await run({ pay: async () => ({ result: { ok: true, order: { reference_code: "B-1", payment_status: "paid" } }, fresh: false }) })
    await run({}, good, TEST_CTX)
    spy.mockRestore()
    expect(docStatuses(BILLS.pay)).toEqual([...produced].sort())
  })

  it("bill lookup: documented statuses == statuses the handler produces", async () => {
    const spy = quiet()
    const produced = new Set<number>(ACCESS_STATUSES)
    const base = () => ({ surfaceOpen: async () => true, verify: async () => ({ ok: false, status: 400, error: "x" }) })
    const good = { biller: "dstv", account: "7012345678" }
    const run = async (over: object, b: unknown = good, ctx: object = LIVE_CTX) => {
      const r = await billsMod.billLookupHandler({ ...base(), ...over } as any)(b, ctx as any)
      if (r.error) produced.add(r.status)
    }
    await run({}, null)
    await run({ surfaceOpen: async () => false })
    for (const s of [400, 403, 422, 503, 500]) await run({ verify: async () => ({ ok: false, status: s, error: "x" }) })
    await run({
      verify: async () => {
        throw new Error("x")
      },
    })
    await run({}, { biller: "dstv" }, TEST_CTX)
    spy.mockRestore()
    expect(docStatuses(BILLS.lookup)).toEqual([...produced].sort())
  })

  it("does not leak internals in the commission docs", () => {
    const all = JSON.stringify(v2DocsRegistry.filter((s) => s.group === "commission"))
    expect(all).not.toMatch(/api_v2_idempotency|purchaseAirtime|payBill|supabase|hubtel_bill_orders|deduct_wallet/i)
  })
})
