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
import * as resultsMod from "../endpoints/results"
import * as afaMod from "../endpoints/afa"
import * as smsMod from "../endpoints/sms"
import * as smsRules from "../sms-rules"
import {
  GH_REGIONS,
  parseExamBoard,
  parseVoucherQuantity,
  parseResultsBody,
  parseAfaBody,
  mapResultsOrder,
  mapVoucher,
  mapAfaOrder,
  mapAfaFulfillment,
  resultsErrorResponse,
  afaErrorResponse,
  classifyResultsError,
  classifyAfaError,
} from "../standard-orders"
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
    expect(V2_BASE_URL).toBe("https://api.datagod.store/v2")
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
    expect(prose("key-types").intro).toMatch(/Commission Services keys unlock airtime, utility bill payments and Standard Bundles/)
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

describe("v2DocsRegistry results checker and AFA endpoints", () => {
  type Ep = (typeof endpoints)[number]
  const find = (sig: string): Ep => endpoints.find((x) => `${x.method} ${x.path}` === sig)!
  const msgs = (e: Ep, s: number) => e.errors.filter((x) => x.status === s).map((x) => x.message)
  const text = (s: { intro?: string; steps?: string[]; callouts?: { body: string; title?: string }[] }) =>
    [s.intro ?? "", ...(s.steps ?? []), ...(s.callouts ?? []).flatMap((c) => [c.title ?? "", c.body])].join(" ")
  const prose = (id: string) => v2DocsRegistry.find((s) => s.id === id)!
  const data = (sig: string) => (find(sig).successExample as { data: any }).data
  const RES = {
    types: "GET /resultschecker/types",
    purchase: "POST /resultschecker/purchase",
    list: "GET /resultschecker/orders",
    order: "GET /resultschecker/orders/{reference}",
  }
  const AFA = {
    register: "POST /afa/register",
    list: "GET /afa/orders",
    order: "GET /afa/orders/{reference}",
  }
  const sigs = [...Object.values(RES), ...Object.values(AFA)]
  const access403 = [MSG_SUSPENDED, MSG_PENDING, MSG_REVOKED, msgWrongKeyType("standard"), MSG_ROLE_NOT_ALLOWED]
  const limitRe = (n: number, g: string) => new RegExp(`${n} requests per minute \\(${g} group\\)`)
  const MAX_QTY = resultsMod.SANDBOX_MAX_QUANTITY // the configurable prod default is the same 15

  const LIVE = { keyId: "k", userId: "u", role: "dealer", keyType: "standard", environment: "live", firstName: null }
  const TEST = { ...LIVE, environment: "test" }
  const quiet = () => vi.spyOn(console, "error").mockImplementation(() => {})
  const ACCESS_STATUSES = [401, 403, 429, 503]
  const docStatuses = (sig: string) => [...new Set(find(sig).errors.map((e) => e.status))].sort()

  // ---- fakes over the real handlers
  const resultsEngine = async (p: { userId: string; examBoard: string; quantity: number }) => ({
    order: { reference_code: "RC-AAA", exam_board: p.examBoard, quantity: p.quantity, unit_price: 25, total_paid: 25 * p.quantity, status: "completed", created_at: "2026-10-22T09:30:00.000Z" },
    vouchers: [{ pin: "TEST-00000001", serial_number: "SANDBOX-WASSCE-0001" }],
    newBalance: 70.5,
  })
  const rcRow = { reference_code: "RC-AAA", exam_board: "WASSCE", quantity: 2, unit_price: 25, total_paid: 50, status: "completed", created_at: "2026-10-22T09:30:00.000Z" }
  const resultsDeps = (over: object = {}): any => ({
    claim: async () => ({ kind: "claimed", claimId: "c1" }),
    complete: async () => true,
    release: async () => true,
    markUnknown: async () => true,
    alert: async () => {},
    getClaim: async () => ({ orderRef: "RC-AAA", status: "done", response: { reference: "RC-2026-0001" } }),
    listClaims: async () => [{ reference: "RC-2026-0001", orderRef: "RC-AAA", status: "done" }],
    engine: resultsEngine,
    getMaxQuantity: async () => MAX_QTY,
    boardEnabled: async () => true,
    available: async () => 100,
    price: async (_b: string, q: number) => ({ unitPrice: 25, totalPaid: 25 * q }),
    readVouchers: async () => [{ pin: "TEST-00000001", serial_number: "SANDBOX-WASSCE-0001" }],
    getOrderByCode: async () => rcRow,
    getOrdersByCodes: async () => [rcRow],
    deliver: async () => {},
    phoneGate: async () => true,
    sandbox: { getOrder: async () => null, listOrders: async () => [], place: async () => ({ success: false, error: "x", status: 402 }) },
    now: () => Date.parse("2026-10-22T09:35:00.000Z"),
    ...over,
  })
  const afaRow = { order_code: "AFA-AAA", full_name: "Ama Serwaa Boateng", phone_number: "0244000001", region: "Greater Accra", amount: 10, status: "pending", fulfillment_status: "unfulfilled", created_at: "2026-10-22T09:30:00.000Z" }
  const afaDeps = (over: object = {}): any => ({
    claim: async () => ({ kind: "claimed", claimId: "c1" }),
    complete: async () => true,
    release: async () => true,
    markUnknown: async () => true,
    alert: async () => {},
    getClaim: async () => ({ orderRef: "AFA-AAA", status: "done", response: {} }),
    listClaims: async () => [{ reference: "AFA-2026-0001", orderRef: "AFA-AAA", status: "done" }],
    engine: async () => ({ order: afaRow }),
    findRecentDuplicate: async () => false,
    getOrderByCode: async () => afaRow,
    getOrdersByCodes: async () => [afaRow],
    phoneGate: async () => true,
    afaPrice: async () => 10,
    sandbox: { getOrder: async () => null, listOrders: async () => [], place: async () => ({ success: false, error: "x", status: 402 }) },
    now: () => Date.parse("2026-10-22T09:35:00.000Z"),
    ...over,
  })
  const rcBody = { exam_board: "WASSCE", quantity: 2, reference: "RC-2026-0001" }
  const coded = (code?: string) => async () => {
    throw Object.assign(new Error("x"), { code })
  }

  // ---- real messages, derived from the code
  const failMsg = (r: { ok: boolean }): string => (r.ok ? "" : String((r as unknown as { error: string }).error))
  const exported: string[] = [...Object.values(resultsMod), ...Object.values(afaMod)].flatMap((v: unknown) => (typeof v === "string" ? [v] : []))
  const goodAfa = { reference: "AFA-2026-0001", full_name: "Ama Serwaa Boateng", phone: "0244000001", id_type: "Ghana Card", id_number: "GHA-000000000-0", region: "Greater Accra", location: "Madina, Accra" }
  const parserMsgs = (): string[] => {
    const good = rcBody
    const out = [null, { ...good, price: 1 }, { ...good, exam_board: "x" }, { ...good, quantity: 0 }, { ...good, reference: "" }, { ...good, recipient_phone: "1" }, { ...good, recipient_email: "nope" }].map((b) =>
      failMsg(parseResultsBody(b, MAX_QTY))
    )
    for (const b of [
      null,
      { ...goodAfa, price: 1 },
      { ...goodAfa, reference: "" },
      { ...goodAfa, full_name: "A" },
      { ...goodAfa, phone: "1" },
      { ...goodAfa, id_type: "Passport" },
      { ...goodAfa, id_number: "1" },
      { ...goodAfa, region: "Mars" },
      { ...goodAfa, location: "x" },
      { ...goodAfa, occupation: "x".repeat(81) },
    ]) {
      out.push(failMsg(parseAfaBody(b)))
    }
    return out
  }
  const engineMsg = (r: { code: string; message: string }) => `${r.code}: ${r.message}`
  const realMessages = new Set<string>([
    ...exported,
    ...parserMsgs(),
    engineMsg(resultsErrorResponse({ code: "INSUFFICIENT_INVENTORY" })),
    engineMsg(afaErrorResponse({ code: "PRICE_UNAVAILABLE" })),
    MSG_UNAUTHORIZED,
    MSG_UNAVAILABLE,
    MSG_RATE_LIMITED,
    MSG_PHONE_GATE,
    MSG_REFERENCE_REUSED,
    MSG_CATALOG_UNAVAILABLE,
    ...access403,
  ])
  const templatePrefixes = [
    "INSUFFICIENT_BALANCE: wallet balance is too low; required ",
    "INSUFFICIENT_BALANCE: test balance is too low; required ",
    "OUT_OF_STOCK: ",
  ]
  const templateSuffixes = [" vouchers are currently unavailable"]

  it("documents all seven endpoints with key type standard in the results group", () => {
    for (const sig of sigs) {
      const e = find(sig)
      expect(e, sig).toBeDefined()
      expect(e.keyType).toBe("standard")
      expect(e.group).toBe("results")
      expect(e.notes.length).toBeGreaterThan(0)
      expect(e.summary.length).toBeGreaterThan(20)
      expect(Object.keys(e.successExample)).toEqual(["success", "data", "meta"])
    }
    expect(sigs).toHaveLength(7)
    const inSection = (id: string) => prose(id).endpoints.map((e) => `${e.method} ${e.path}`)
    expect(inSection("results-types")).toEqual([RES.types])
    expect(inSection("results-purchase")).toEqual([RES.purchase])
    expect(inSection("results-orders")).toEqual([RES.list, RES.order])
    expect(inSection("afa-register")).toEqual([AFA.register])
    expect(inSection("afa-orders")).toEqual([AFA.list, AFA.order])
  })

  it("takes rate-limit strings from limits.ts: purchase group for purchase and register, status for the rest", () => {
    expect(find(RES.purchase).rateLimit).toMatch(limitRe(DEFAULT_LIMITS.purchase, "purchase"))
    expect(find(AFA.register).rateLimit).toMatch(limitRe(DEFAULT_LIMITS.purchase, "purchase"))
    for (const sig of [RES.types, RES.list, RES.order, AFA.list, AFA.order]) {
      expect(find(sig).rateLimit).toMatch(limitRe(DEFAULT_LIMITS.status, "status"))
    }
  })

  it("documents params and request examples that the real parsers accept", () => {
    expect(find(RES.purchase).params.map((p) => p.name)).toEqual(["exam_board", "quantity", "reference", "recipient_phone", "recipient_email"])
    expect(find(RES.purchase).params.filter((p) => p.required).map((p) => p.name)).toEqual(["exam_board", "quantity", "reference"])
    expect(find(AFA.register).params.map((p) => p.name)).toEqual(["reference", "full_name", "phone", "id_type", "id_number", "region", "location", "occupation"])
    expect(find(AFA.register).params.filter((p) => p.required).map((p) => p.name)).toEqual(["reference", "full_name", "phone", "id_type", "id_number", "region", "location"])
    for (const sig of [RES.order, AFA.order]) expect(find(sig).params.map((p) => p.name)).toEqual(["reference"])
    for (const sig of [RES.types, RES.list, AFA.list]) expect(find(sig).params).toEqual([])
    for (const sig of [RES.types, RES.list, RES.order, AFA.list, AFA.order]) expect(find(sig).requestExample).toBeNull()
    expect(parseResultsBody(find(RES.purchase).requestExample, MAX_QTY).ok).toBe(true)
    expect(parseAfaBody(find(AFA.register).requestExample).ok).toBe(true)
    for (const sig of [RES.purchase, AFA.register]) {
      expect(Object.keys(find(sig).requestExample as object).join(" ")).not.toMatch(/price|fee|total|cashback|amount|status/i)
    }
    expect(Object.keys(find(AFA.register).requestExample as object)).not.toContain("date_of_birth")
    // Limits in the param text come from the parsers.
    const qty = find(RES.purchase).params.find((p) => p.name === "quantity")!.description
    expect(qty).toContain(String(MAX_QTY))
    expect(qty).toMatch(/set by Datagod/i)
    expect(parseVoucherQuantity(MAX_QTY, MAX_QTY).ok).toBe(true)
    expect(parseVoucherQuantity(MAX_QTY + 1, MAX_QTY).ok).toBe(false)
    const board = find(RES.purchase).params.find((p) => p.name === "exam_board")!.description
    for (const b of ["WASSCE", "BECE", "NOVDEC"]) {
      expect(parseExamBoard(b).ok).toBe(true)
      expect(board).toContain(b)
    }
    expect(parseExamBoard("x")).toEqual({ ok: false, error: "exam_board must be one of: WASSCE, BECE, NOVDEC" })
    expect(find(AFA.register).params.find((p) => p.name === "id_type")!.description).toContain("Ghana Card")
    expect(find(AFA.register).params.find((p) => p.name === "region")!.description).toContain(GH_REGIONS.join(", "))
  })

  it("documented boards equal the parser's and the types endpoint's", async () => {
    const r = await resultsMod.typesHandler(resultsDeps())(LIVE as any)
    const boards = (r.data as any).types.map((t: any) => t.exam_board)
    expect(boards).toEqual([...resultsMod.RESULTS_BOARDS])
    expect(data(RES.types).types.map((t: any) => t.exam_board)).toEqual(boards)
    for (const b of boards) expect(parseExamBoard(b).ok).toBe(true)
  })

  it("success examples have exactly the keys the real handlers return", async () => {
    const orderKeys = Object.keys(mapResultsOrder({}, "x")).sort()
    const voucherKeys = Object.keys(mapVoucher({})).sort()
    expect(orderKeys).toEqual(["created_at", "exam_board", "quantity", "reference", "status", "total_paid", "unit_price"])
    expect(voucherKeys).toEqual(["pin", "serial_number"])
    const afaKeys = Object.keys(mapAfaOrder({}, "x")).sort()
    expect(afaKeys).toEqual(["amount", "created_at", "fulfillment", "full_name", "phone", "reference", "region", "status"])

    const keys = (o: object) => Object.keys(o).sort()
    const live = async (r: Promise<any>) => (await r).data
    // results
    const types = await live(resultsMod.typesHandler(resultsDeps())(LIVE as any))
    expect(keys(data(RES.types).types[0])).toEqual(keys(types.types[0]))
    const purchase = await live(resultsMod.purchaseResultsHandler(resultsDeps())(rcBody, LIVE as any))
    expect(keys(data(RES.purchase))).toEqual(keys(purchase))
    expect(keys(data(RES.purchase).order)).toEqual(orderKeys)
    for (const v of data(RES.purchase).vouchers) expect(keys(v)).toEqual(voucherKeys)
    const lookup = await live(resultsMod.resultsOrderHandler(resultsDeps())("RC-2026-0001", LIVE as any))
    expect(keys(data(RES.order))).toEqual(keys(lookup))
    expect(keys(data(RES.order).order)).toEqual(orderKeys)
    for (const v of data(RES.order).vouchers) expect(keys(v)).toEqual(voucherKeys)
    expect(data(RES.order).claim).toBeNull()
    const list = await live(resultsMod.resultsListHandler(resultsDeps())(LIVE as any))
    expect(keys(data(RES.list))).toEqual(keys(list))
    for (const o of data(RES.list).orders) expect(keys(o)).toEqual(orderKeys)
    // afa
    const reg = await live(afaMod.registerAfaHandler(afaDeps())(goodAfa, LIVE as any))
    expect(keys(data(AFA.register))).toEqual(keys(reg))
    expect(keys(data(AFA.register).order)).toEqual(afaKeys)
    const alookup = await live(afaMod.afaOrderHandler(afaDeps())("AFA-2026-0001", LIVE as any))
    expect(keys(data(AFA.order))).toEqual(keys(alookup))
    expect(keys(data(AFA.order).order)).toEqual(afaKeys)
    expect(data(AFA.order).claim).toBeNull()
    const alist = await live(afaMod.afaListHandler(afaDeps())(LIVE as any))
    expect(keys(data(AFA.list))).toEqual(keys(alist))
    for (const o of data(AFA.list).orders) expect(keys(o)).toEqual(afaKeys)
    // Status values in the examples are values the mappers produce.
    for (const o of [data(RES.purchase).order, data(RES.order).order, data(RES.list).orders[0], data(AFA.register).order, data(AFA.order).order, data(AFA.list).orders[0]]) {
      expect(mapCommissionStatus(o.status)).toBe(o.status)
    }
    for (const o of [data(AFA.register).order, data(AFA.order).order, data(AFA.list).orders[0]]) expect(mapAfaFulfillment(o.fulfillment)).toBe(o.fulfillment)
    expect(typeof data(RES.purchase).new_balance).toBe("number")
    // The total is quantity times the unit price.
    const o = data(RES.purchase).order
    expect(cents2(o.total_paid)).toBe(o.quantity * cents2(o.unit_price))
    expect(data(RES.purchase).vouchers).toHaveLength(o.quantity)
    expect(data(RES.purchase).order.reference).toBe((find(RES.purchase).requestExample as any).reference)
    expect(parseResultsBody(find(RES.purchase).requestExample, MAX_QTY)).toMatchObject({ ok: true, value: { quantity: o.quantity } })
  })
  const cents2 = (n: number) => Math.round(n * 100)

  it("example PINs are obviously fake, the list and types never carry a PIN, and no real-looking Ghana Card appears", () => {
    for (const sig of [RES.purchase, RES.order]) {
      const vs = data(sig).vouchers
      expect(vs.length).toBeGreaterThan(0)
      for (const v of vs) {
        expect(v.pin).toMatch(/^(TEST|SANDBOX|DEMO)-/)
        expect(v.serial_number).toMatch(/^(TEST|SANDBOX|DEMO)-/)
      }
    }
    for (const sig of [RES.types, RES.list]) expect(JSON.stringify(find(sig).successExample)).not.toMatch(/"pin"|serial_number|vouchers/)
    for (const sig of [AFA.register, AFA.list, AFA.order]) expect(JSON.stringify(find(sig).successExample)).not.toMatch(/id_number|ghana|GHA-/i)
    const everything = JSON.stringify(v2DocsRegistry.filter((s) => s.group === "results"))
    const cards = everything.match(/GHA-?\d{9}-?\d/gi) ?? []
    expect(cards.length).toBeGreaterThan(0)
    for (const c of cards) expect(c).toBe("GHA-000000000-0")
    // Phone numbers in examples are the documented fake range.
    for (const m of everything.match(/\b0\d{9}\b/g) ?? []) expect(m).toMatch(/^02440000\d\d$/)
  })

  it("every documented error is a real handler message or an allowed template", () => {
    for (const sig of sigs) {
      for (const err of find(sig).errors) {
        const real =
          realMessages.has(err.message) ||
          templatePrefixes.some((p) => err.message.startsWith(p)) ||
          templateSuffixes.some((s) => err.message.endsWith(s)) ||
          // the quantity message carries the configured maximum
          err.message === failMsg(parseVoucherQuantity("x", MAX_QTY))
        expect(real, `${sig} ${err.status} ${err.message}`).toBe(true)
        expect(VALID_STATUS).toContain(err.status as V2ErrorStatus)
      }
    }
  })

  it("access errors use the real standard-key strings on every endpoint", () => {
    for (const sig of sigs) {
      const e = find(sig)
      expect(msgs(e, 401)).toEqual([MSG_UNAUTHORIZED])
      expect(msgs(e, 429)).toEqual([MSG_RATE_LIMITED])
      for (const m of access403) expect(msgs(e, 403), sig).toContain(m)
      expect(msgs(e, 503)).toContain(MSG_UNAVAILABLE)
    }
    for (const sig of [RES.purchase, AFA.register]) expect(msgs(find(sig), 403)).toContain(MSG_PHONE_GATE)
    // None of the machine-code strings claim the commission key type.
    expect(JSON.stringify(sigs.map((s) => find(s).errors))).not.toContain(msgWrongKeyType("commission"))
  })

  it("documents the 409 machine codes, 402 wording, and 500/503 outcomes with the real strings", () => {
    const p = find(RES.purchase)
    expect(msgs(p, 409)).toEqual(
      expect.arrayContaining([resultsMod.MSG_RESULTS_IN_PROGRESS, resultsMod.MSG_RESULTS_PRIOR_UNKNOWN, MSG_REFERENCE_REUSED])
    )
    expect(msgs(p, 409).some((m) => m.startsWith("OUT_OF_STOCK: "))).toBe(true)
    expect(msgs(p, 402)).toContain("INSUFFICIENT_BALANCE: wallet balance is too low; required 50.00")
    expect(msgs(p, 402)).toContain("INSUFFICIENT_BALANCE: test balance is too low; required 50.00")
    expect(msgs(p, 500)).toContain(resultsMod.MSG_RESULTS_OUTCOME_UNKNOWN)
    // INSUFFICIENT_INVENTORY (charged, then unassigned) is an unknown outcome: 500, never 503.
    expect(msgs(p, 500)).toContain(engineMsg(resultsErrorResponse({ code: "INSUFFICIENT_INVENTORY" })))
    expect(msgs(p, 503).some((m) => m.includes("ran out after the wallet was charged"))).toBe(false)
    expect(msgs(p, 503)).toEqual(
      expect.arrayContaining([
        resultsMod.MSG_RESULTS_CLAIM_UNAVAILABLE,
        resultsMod.MSG_RESULTS_PRICE_UNAVAILABLE,
        resultsMod.MSG_VOUCHERS_UNAVAILABLE,
        MSG_CATALOG_UNAVAILABLE,
      ])
    )
    // VOUCHERS_UNAVAILABLE is its own code (a charged order), never the "nothing was charged" UNAVAILABLE one.
    expect(resultsMod.MSG_VOUCHERS_UNAVAILABLE).toMatch(/^VOUCHERS_UNAVAILABLE: your order was placed and charged/)
    const purchaseNotes = p.notes.join(" ")
    expect(purchaseNotes).toContain("VOUCHERS_UNAVAILABLE")
    expect(purchaseNotes).not.toMatch(/503 INSUFFICIENT_INVENTORY/)
    expect(purchaseNotes).toMatch(/vouchers ran out after the wallet was charged is also OUTCOME_UNKNOWN/)
    expect(purchaseNotes).toMatch(/503 whose message starts with UNAVAILABLE[^.]*nothing was charged/)
    // No "role" pricing claims on the results docs; the max is "currently", not "by default".
    const resultsDocs = JSON.stringify(v2DocsRegistry.filter((s) => s.group === "results"))
    expect(resultsDocs).not.toMatch(/account's role|account role|from your role/i)
    expect(resultsDocs).toContain("the same price applies to every account")
    expect(resultsDocs).toMatch(/it is currently 15/)
    expect(resultsDocs).not.toMatch(/15 by default/)
    // The Ghana Card example is labelled a placeholder to replace.
    expect(resultsDocs).toMatch(/PLACEHOLDER that must be replaced with a real card number/)
    expect(msgs(p, 503).some((m) => m === "WASSCE vouchers are currently unavailable")).toBe(true)
    const r = find(AFA.register)
    expect(msgs(r, 409)).toEqual(expect.arrayContaining([afaMod.MSG_AFA_IN_PROGRESS, afaMod.MSG_AFA_PRIOR_UNKNOWN, afaMod.MSG_AFA_DUPLICATE, MSG_REFERENCE_REUSED]))
    expect(msgs(r, 500)).toContain(afaMod.MSG_AFA_OUTCOME_UNKNOWN)
    expect(msgs(r, 503)).toEqual(expect.arrayContaining([afaMod.MSG_AFA_CLAIM_UNAVAILABLE, MSG_CATALOG_UNAVAILABLE, engineMsg(afaErrorResponse({ code: "PRICE_UNAVAILABLE" }))]))
    expect(msgs(r, 402)).toContain("INSUFFICIENT_BALANCE: wallet balance is too low; required 10.00")
    expect(msgs(find(RES.order), 404)).toEqual([resultsMod.MSG_RESULTS_NOT_FOUND])
    expect(msgs(find(AFA.order), 404)).toEqual([afaMod.MSG_AFA_NOT_FOUND])
    expect(msgs(find(RES.order), 503)).toContain(resultsMod.MSG_VOUCHERS_UNAVAILABLE)
    // Engine classification the notes rely on: only a no-charge code frees the reference.
    expect(classifyResultsError("INSUFFICIENT_BALANCE")).toBe("no_charge")
    expect(classifyResultsError("INSUFFICIENT_INVENTORY")).toBe("ambiguous")
    expect(classifyAfaError("PAYMENT_FAILED")).toBe("ambiguous")
  })

  it("results purchase: documented statuses == statuses the handler produces", async () => {
    const spy = quiet()
    const produced = new Set<number>(ACCESS_STATUSES)
    const run = async (over: object, b: unknown = rcBody, ctx: object = LIVE) => {
      const r = await resultsMod.purchaseResultsHandler(resultsDeps(over))(b, ctx as any)
      if (r.error) produced.add(r.status)
    }
    await run({}, null)
    await run({ getMaxQuantity: coded() })
    for (const kind of ["conflict", "in_progress", "unknown", "error"]) await run({ claim: async () => ({ kind }) })
    await run({ claim: async () => ({ kind: "replay", orderRef: "RC-AAA", response: {} }), getOrderByCode: async () => null })
    await run({ boardEnabled: async () => false })
    await run({ available: async () => 0 })
    await run({ phoneGate: async () => false })
    await run({ price: async () => ({ unitPrice: 0, totalPaid: 0 }) })
    for (const code of ["INSUFFICIENT_BALANCE", "INSUFFICIENT_INVENTORY", undefined]) await run({ engine: coded(code) })
    await run({ getMaxQuantity: coded() }, rcBody, TEST)
    await run({ sandbox: { ...resultsDeps().sandbox, place: async () => ({ success: false, error: "x", status: 402 }) } }, rcBody, TEST)
    await run({ sandbox: { ...resultsDeps().sandbox, place: async () => ({ success: false, error: "x", status: 500 }) } }, rcBody, TEST)
    spy.mockRestore()
    expect(docStatuses(RES.purchase)).toEqual([...produced].sort())
  })

  it("results lookups and AFA register/lookups: documented statuses == statuses the handlers produce", async () => {
    const spy = quiet()
    const collect = async (base: number[], runs: (() => Promise<{ error?: unknown; status: number }>)[]) => {
      const produced = new Set<number>(base)
      for (const r of runs) {
        const res = await r()
        if (res.error) produced.add(res.status)
      }
      return [...produced].sort()
    }
    const rl = (o: object, ctx: object = LIVE) => () => resultsMod.resultsOrderHandler(resultsDeps(o))("RC-2026-0001", ctx as any)
    expect(docStatuses(RES.order)).toEqual(
      await collect(ACCESS_STATUSES, [
        () => resultsMod.resultsOrderHandler(resultsDeps())("x", LIVE as any),
        rl({ getOrderByCode: async () => null }),
        rl({}, TEST),
        rl({ sandbox: { ...resultsDeps().sandbox, getOrder: coded() } }, TEST),
      ])
    )
    const ll = (o: object, ctx: object = LIVE) => () => resultsMod.resultsListHandler(resultsDeps(o))(ctx as any)
    expect(docStatuses(RES.list)).toEqual(await collect(ACCESS_STATUSES, [ll({ listClaims: async () => null }), ll({ sandbox: { ...resultsDeps().sandbox, listOrders: coded() } }, TEST)]))
    expect(docStatuses(RES.types)).toEqual(
      await collect(ACCESS_STATUSES, [() => resultsMod.typesHandler(resultsDeps({ boardEnabled: coded() }))(LIVE as any)])
    )

    const reg = (o: object, b: unknown = goodAfa, ctx: object = LIVE) => () => afaMod.registerAfaHandler(afaDeps(o))(b, ctx as any)
    const afaRuns = [
      reg({}, null),
      ...["conflict", "in_progress", "unknown", "error"].map((kind) => reg({ claim: async () => ({ kind }) })),
      reg({ phoneGate: async () => false }),
      reg({ findRecentDuplicate: async () => true }),
      reg({ findRecentDuplicate: coded() }),
      ...["INVALID_GHANA_CARD", "PRICE_UNAVAILABLE", "INSUFFICIENT_BALANCE", "PAYMENT_FAILED", "ORDER_CREATE_FAILED", undefined].map((c) => reg({ engine: coded(c) })),
      reg({ afaPrice: coded() }, goodAfa, TEST),
      reg({ sandbox: { ...afaDeps().sandbox, place: async () => ({ success: false, error: "x", status: 500 }) } }, goodAfa, TEST),
      reg({ sandbox: { ...afaDeps().sandbox, place: async () => ({ success: false, error: "x", status: 402 }) } }, goodAfa, TEST),
    ]
    expect(docStatuses(AFA.register)).toEqual(await collect(ACCESS_STATUSES, afaRuns))
    const al = (o: object, ctx: object = LIVE) => () => afaMod.afaOrderHandler(afaDeps(o))("AFA-2026-0001", ctx as any)
    expect(docStatuses(AFA.order)).toEqual(
      await collect(ACCESS_STATUSES, [() => afaMod.afaOrderHandler(afaDeps())("x", LIVE as any), al({ getClaim: async () => null }), al({ sandbox: { ...afaDeps().sandbox, getOrder: coded() } }, TEST)])
    )
    const alist = (o: object, ctx: object = LIVE) => () => afaMod.afaListHandler(afaDeps(o))(ctx as any)
    expect(docStatuses(AFA.list)).toEqual(await collect(ACCESS_STATUSES, [alist({ listClaims: async () => null }), alist({ sandbox: { ...afaDeps().sandbox, listOrders: coded() } }, TEST)]))
    spy.mockRestore()
  })

  it("documented regions equal GH_REGIONS and the parser's error message", () => {
    const sec = text(prose("afa-registration"))
    for (const r of GH_REGIONS) expect(sec).toContain(r)
    expect(GH_REGIONS).toHaveLength(16)
    expect(sec).toContain(GH_REGIONS.join(", "))
    const regionErr = failMsg(parseAfaBody({ ...goodAfa, region: "Mars" }))
    expect(msgs(find(AFA.register), 400)).toContain(regionErr)
    expect(regionErr).toBe(`region must be one of: ${GH_REGIONS.join(", ")}`)
  })

  it("explains voucher PIN handling", () => {
    const t = text(prose("voucher-pins"))
    expect(t).toMatch(/purchase response/i)
    expect(t).toMatch(/GET \/resultschecker\/orders\/\{reference\}/)
    expect(t).toMatch(/only (the )?(account )?owner|owner only|only you/i)
    expect(t).toMatch(/never log[^.]*(plain text|store)|never (log or )?store/i)
    expect(t).toMatch(/recipient_phone/)
    expect(t).toMatch(/recipient_email/)
    expect(t).toMatch(/never[^.]*(your own|account owner'?s?|account's)[^.]*(contact|phone|email)/i)
    expect(t).toMatch(/list endpoint[^.]*never[^.]*PINs?/i)
    expect(t).toMatch(/replay[^.]*never re-sends|never re-sends[^.]*replay/i)
    // The lookup note says a non-completed order has no vouchers yet.
    expect(find(RES.order).notes.join(" ")).toMatch(/vouchers: \[\]|empty/i)
  })

  it("explains AFA registration fields, the card format, no date of birth and the duplicate window", () => {
    const t = text(prose("afa-registration"))
    expect(t).toContain("Ghana Card")
    expect(t).toContain("GHA-000000000-0")
    expect(t).toMatch(/date of birth/i)
    expect(t).toMatch(/not required/i)
    expect(t).toContain("DUPLICATE_REGISTRATION")
    expect(t).toContain(`${afaMod.AFA_DUPLICATE_WINDOW_MS / 60000} minutes`)
    expect(t).toMatch(/same phone number or the same Ghana Card/i)
    expect(parseAfaBody({ ...goodAfa, id_type: "Passport" })).toEqual({ ok: false, error: 'id_type must be "Ghana Card"' })
    expect(parseAfaBody({ ...goodAfa, id_number: "GHA-123456789-0", date_of_birth: "x" }).ok).toBe(true)
    expect(parseAfaBody({ ...goodAfa, id_number: "123456789-0" }).ok).toBe(true)
    // The card number never comes back.
    expect(JSON.stringify(find(AFA.register).notes)).toMatch(/Ghana Card number[^.]*(never|not)[^.]*(returned|echo|logged)/i)
  })

  it("claim states and the stale window in the lookup notes match the code", () => {
    const states = [mapClaimState({ status: "in_progress", createdAt: new Date().toISOString() }, "r", Date.now())!.state, mapClaimState({ status: "unknown" }, "r", Date.now())!.state]
    expect(states).toEqual(["in_progress", "outcome_unknown"])
    expect(CLAIM_STALE_MS / 60000).toBe(10)
    for (const sig of [RES.order, AFA.order]) {
      const n = find(sig).notes.join(" ")
      for (const s of states) expect(n).toContain(s)
      expect(n).toMatch(/order: null/)
      expect(n).toMatch(/claim: \{ reference, state \}/)
      expect(n).toMatch(/claim: null/)
      expect(n).toMatch(/10 minutes/)
      expect(n).toMatch(/identical 404/i)
      expect(n).toMatch(/sandbox: true/)
    }
  })

  it("documents replay semantics, the quantity of retries, and the PHONE_NOT_VERIFIED gate", () => {
    for (const sig of [RES.purchase, AFA.register]) {
      const n = find(sig).notes.join(" ")
      expect(n).toMatch(/HTTP 201/)
      expect(n).toMatch(/replayed: true/)
      expect(n).toMatch(/not charged a second time/i)
      expect(n).toMatch(/REFERENCE_REUSED/)
      expect(n).toMatch(/REQUEST_IN_PROGRESS/)
      expect(n).toMatch(/OUTCOME_UNKNOWN/)
      expect(n).toMatch(/PHONE_NOT_VERIFIED/)
      expect(n).toMatch(/never[^.]*new reference|Do not[^.]*new reference/i)
    }
    expect(find(RES.purchase).notes.join(" ")).toMatch(/PINs?[^.]*(repeated|returned again)[^.]*replay|replay[^.]*PINs?/i)
    expect(find(RES.purchase).notes.join(" ")).toMatch(/OUT_OF_STOCK/)
    expect(find(RES.purchase).notes.join(" ")).toMatch(/nothing (was )?charged/i)
    expect(find(AFA.register).notes.join(" ")).toMatch(/DUPLICATE_REGISTRATION/)
  })

  it("states sandbox behaviour for results and AFA and extends the shared prose", () => {
    const rp = find(RES.purchase).notes.join(" ")
    expect(rp).toMatch(/test key[^.]*fake[^.]*TEST-[^.]*PINs?/i)
    expect(rp).toMatch(/sandbox wallet/i)
    expect(rp).toMatch(/no provider|never contact|no (real )?(voucher|order)/i)
    const ap = find(AFA.register).notes.join(" ")
    expect(ap).toMatch(/test key/i)
    expect(ap).toMatch(/sandbox wallet/i)
    expect(ap).toMatch(/price[^.]*read|reads? the (real |active )?(AFA )?price/i)
    expect(ap).toMatch(/nothing is registered|no registration is (sent|made|submitted)/i)
    const sb = prose("sandbox").intro!
    expect(sb).toMatch(/results checker/i)
    expect(sb).toMatch(/AFA/)
    expect(sb).toMatch(/TEST-/)
    expect(sb).toMatch(/sandbox references are unique per account across all order types/i)
    expect(sb).toMatch(/live references are unique per order type/i)
    const idem = prose("idempotency").intro!
    expect(idem).toMatch(/results checker/i)
    expect(idem).toMatch(/AFA/)
    expect(idem).not.toMatch(/unique across all developers/i)
    expect(idem).toMatch(/per account|your account/i)
    expect(idem).toMatch(/PINs?/)
    const ri = text(prose("results-idempotency"))
    expect(ri).toMatch(/results checker/i)
    expect(ri).toMatch(/AFA/)
    expect(ri).toMatch(/REFERENCE_REUSED/)
    expect(ri).toMatch(/REQUEST_IN_PROGRESS/)
    expect(ri).toMatch(/OUTCOME_UNKNOWN/)
    expect(ri).toMatch(/10 minutes/)
    expect(ri).toMatch(/sandbox references are unique per account across all order types/i)
    expect(ri).toMatch(/live references are unique per order type/i)
    expect(ri).toMatch(/distinct prefix/i)
  })

  it("no Start prose still says results checkers or AFA are coming later, and key types and auth say standard keys unlock them", () => {
    const all = v2DocsRegistry.map((s) => text(s)).join(" ") + " " + JSON.stringify(endpoints.map((e) => e.notes))
    expect(all).not.toMatch(/(results checkers?|AFA)[^.]*(not part of|arriving|coming|later releases?|soon)/i)
    expect(all).not.toMatch(/(not part of|arriving|coming|later releases?|soon)[^.]*(results checkers?|AFA)/i)
    expect(prose("overview").intro).toMatch(/results checker/i)
    expect(prose("overview").intro).toMatch(/AFA/)
    expect(prose("overview").intro).toMatch(/SMS/)
    expect(prose("authentication").intro).toMatch(/standard key[^.]*results checker[^.]*AFA/i)
    expect(prose("key-types").intro).toMatch(/Standard keys unlock[^.]*results checker[^.]*AFA/i)
  })

  it("does not leak internals in the results and AFA docs", () => {
    const all = JSON.stringify(v2DocsRegistry.filter((s) => s.group === "results"))
    expect(all).not.toMatch(/api_v2_idempotency|purchaseResultsCheckerVouchers|submitAfaOrder|supabase|results_checker_orders|afa_orders|deduct_wallet/i)
  })
})

// ---------------------------------------------------------------- SMS group

describe("v2DocsRegistry SMS endpoints", () => {
  type Ep = (typeof endpoints)[number]
  const find = (sig: string): Ep => endpoints.find((x) => `${x.method} ${x.path}` === sig)!
  const prose = (id: string) => v2DocsRegistry.find((s) => s.id === id)!
  const text = (s: { intro?: string; steps?: string[]; callouts?: { body: string; title?: string }[] }) =>
    [s.intro ?? "", ...(s.steps ?? []), ...(s.callouts ?? []).flatMap((c) => [c.title ?? "", c.body])].join(" ")
  const SMS = {
    send: "POST /sms/send",
    balance: "GET /sms/balance",
    senders: "GET /sms/senders",
    campaigns: "GET /sms/campaigns",
    campaign: "GET /sms/campaigns/{campaign_id}",
  }
  const sigs = Object.values(SMS)
  const ACCESS_STATUSES = [401, 403, 429, 503]
  const docStatuses = (sig: string) => [...new Set(find(sig).errors.map((e) => e.status))].sort()
  const docMsgs = (sig: string) => find(sig).errors.map((e) => e.message)
  const quiet = () => vi.spyOn(console, "error").mockImplementation(() => {})
  const LIVE = { keyId: "k", userId: "u", role: "dealer", keyType: "sms", environment: "live", firstName: null } as any
  const TEST = { ...LIVE, environment: "test" } as any
  const ACCOUNT = { id: "acc-1", user_id: "u", unit_balance: 480, status: "active", default_sender_id: "s1" } as any
  const NOW = new Date("2026-10-27T10:00:00Z")
  const goodBody = { reference: "SMS-2026-0001", message: "Hello from Acme", recipients: ["0244000001", "0244000002"], sender_id: "ACMEBRAND" }
  const ENGINE_OK = { ok: true, batches: 1, totalQueued: 2, segments: 1, creditsReserved: 2, invalidSkipped: 0, sendLogId: 1042 }

  const deps = (over: Record<string, unknown> = {}): any => ({
    claim: async () => ({ kind: "claimed", claimId: "c1" }),
    complete: async () => true,
    release: async () => true,
    markUnknown: async () => true,
    alert: async () => {},
    getOrCreateAccount: async () => ACCOUNT,
    lookupAccount: async () => ACCOUNT,
    resolveSender: async () => "ACMEBRAND",
    shopTokens: async () => ({}),
    engine: async () => ENGINE_OK,
    listCampaigns: async () => ({ rows: [], total: 0, page: 1, pageSize: smsMod.SMS_PAGE_SIZE }),
    getCampaign: async () => null,
    listSenders: async () => [],
    pendingUnits: async () => 0,
    now: () => NOW.getTime(),
    ...over,
  })
  const boom = async () => {
    throw new Error("db")
  }

  it("documents the five endpoints with key type sms in the sms group", () => {
    for (const sig of sigs) {
      const e = find(sig)
      expect(e, sig).toBeDefined()
      expect(e.keyType).toBe("sms")
      expect(e.group).toBe("sms")
      expect(e.notes.length).toBeGreaterThan(0)
      expect(Object.keys(e.successExample)).toEqual(["success", "data", "meta"])
    }
    expect(sigs).toHaveLength(5)
    expect(prose("sms-send").endpoints.map((e) => `${e.method} ${e.path}`)).toEqual([SMS.send])
    expect(prose("sms-campaigns").endpoints.map((e) => `${e.method} ${e.path}`)).toEqual([SMS.campaigns, SMS.campaign])
  })

  it("success examples have exactly the shapes the mappers produce", () => {
    const d = (sig: string) => (find(sig).successExample as { data: any }).data
    const send = d(SMS.send).send
    expect(smsRules.mapSendSummary(ENGINE_OK as any)).toEqual(send)
    expect(d(SMS.balance).balance).toEqual(smsRules.mapBalance({ unit_balance: 480, status: "active" } as any, 0))
    const s0 = d(SMS.senders).senders[0]
    expect(smsRules.mapSenders([{ id: "s1", sender_id: "ACMEBRAND", local_status: "active", created_at: s0.created_at }], "s1")).toEqual([s0])
    const camp = d(SMS.campaigns).campaigns[0]
    expect(Object.keys(smsRules.mapCampaign({})).sort()).toEqual(Object.keys(camp).sort())
    expect(d(SMS.campaigns).page_size).toBe(smsMod.SMS_PAGE_SIZE)
    const detail = d(SMS.campaign).campaign
    expect(Object.keys(smsRules.mapCampaignDetail({})).sort()).toEqual(Object.keys(detail).sort())
    expect(Object.keys(detail.recipients[0]).sort()).toEqual(["phone", "refunded", "status"])
    expect(detail.recipients.every((r: any) => /^\+233\d{9}$/.test(r.phone))).toBe(true)
  })

  it("the send request example parses with the real parser and the documented limits are the real ones", () => {
    expect(smsRules.parseSmsSendBody(find(SMS.send).requestExample, NOW).ok).toBe(true)
    expect(JSON.stringify(find(SMS.send).params)).toContain(String(smsRules.SMS_MAX_RECIPIENTS))
    expect(smsMod.SMS_BATCH_SIZE).toBe(500)
    expect(smsMod.SMS_PAGE_SIZE).toBe(25)
    expect(find(SMS.send).notes.join(" ")).toContain(String(smsMod.SMS_BATCH_SIZE))
  })

  it("every documented send message is the real one (parser, schedule, engine mapping, handler constants)", () => {
    const sendMsgs = docMsgs(SMS.send)
    const body = (o: unknown) => {
      const r = smsRules.parseSmsSendBody(o, NOW)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(sendMsgs, r.error).toContain(r.error)
    }
    body(null)
    body({ ...goodBody, price: 1 })
    body({ ...goodBody, reference: "x" })
    body({ ...goodBody, message: "hi" })
    body({ ...goodBody, recipients: [] })
    body({ ...goodBody, sender_id: " " })
    body({ ...goodBody, scheduled_at: "tomorrow" })
    const soon = smsRules.parseSmsSendBody({ ...goodBody, scheduled_at: "2026-10-27T10:00:30Z" }, NOW)
    expect(soon.ok && soon.value.scheduleLeadError).toBeTruthy()
    if (soon.ok) expect(sendMsgs).toContain(soon.value.scheduleLeadError)
    body({ ...goodBody, scheduled_at: "2027-12-01T10:00:00Z" })
    for (const err of ["INSUFFICIENT_CREDITS", "NOT_ACTIVATED", "SUSPENDED", "INVALID_SENDER_ID", "BLOCKED", "POLICY_REJECTED", "SMS_DISABLED", "SEND_IN_PROGRESS", "EMPTY_MESSAGE", "TOO_MANY_RECIPIENTS", "NO_VALID_RECIPIENTS"]) {
      const r = smsRules.smsErrorResponse({ ok: false, error: err })
      expect(sendMsgs, err).toContain(`${r.code}: ${r.message}`)
    }
    for (const m of [smsMod.MSG_SMS_NOT_ENABLED, smsMod.MSG_SMS_IN_PROGRESS, smsMod.MSG_SMS_PRIOR_UNKNOWN, smsMod.MSG_SMS_OUTCOME_UNKNOWN, smsMod.MSG_SMS_CLAIM_UNAVAILABLE, MSG_REFERENCE_REUSED, MSG_CATALOG_UNAVAILABLE]) {
      expect(sendMsgs).toContain(m)
    }
    expect(docMsgs(SMS.campaign)).toContain(smsMod.MSG_SMS_NOT_FOUND)
    expect(docMsgs(SMS.balance)).toContain(smsMod.MSG_SMS_NOT_ENABLED)
    expect(docMsgs(SMS.senders)).toContain(smsMod.MSG_SMS_NOT_ENABLED)
    for (const sig of sigs) expect(docMsgs(sig)).toContain(msgWrongKeyType("sms"))
  })

  it("list endpoint messages are the real validation messages", async () => {
    const page = await smsMod.handleSmsCampaigns(deps())({ page: "0" }, LIVE)
    const status = await smsMod.handleSmsCampaigns(deps())({ status: "bogus" }, LIVE)
    expect(docMsgs(SMS.campaigns)).toContain(page.error!.message)
    expect(docMsgs(SMS.campaigns)).toContain(status.error!.message)
  })

  it("send: documented statuses == statuses the handler produces", async () => {
    const spy = quiet()
    const produced = new Set<number>(ACCESS_STATUSES)
    const run = async (over: Record<string, unknown>, b: unknown = goodBody, ctx: object = LIVE) => {
      const r = await smsMod.handleSmsSend(deps(over))(b, ctx as any)
      if (r.error) produced.add(r.status)
    }
    await run({}, null)
    for (const kind of ["conflict", "in_progress", "unknown", "error"]) await run({ claim: async () => ({ kind }) })
    await run({ getOrCreateAccount: async () => null })
    await run({ getOrCreateAccount: boom })
    await run({ resolveSender: boom })
    await run({ shopTokens: boom })
    await run({ engine: boom })
    for (const error of ["INSUFFICIENT_CREDITS", "NOT_ACTIVATED", "INVALID_SENDER_ID", "SEND_IN_PROGRESS", "ENQUEUE_FAILED", "SMS_DISABLED", "BLOCKED", "WEIRD"]) {
      await run({ engine: async () => ({ ok: false, error }) })
    }
    spy.mockRestore()
    expect(docStatuses(SMS.send)).toEqual([...produced].sort())
  })

  it("balance, senders, campaigns, campaign: documented statuses == statuses the handlers produce", async () => {
    const collect = async (runs: (() => Promise<{ error?: unknown; status: number }>)[]) => {
      const produced = new Set<number>(ACCESS_STATUSES)
      for (const r of runs) {
        const res = await r()
        if (res.error) produced.add(res.status)
      }
      return [...produced].sort()
    }
    expect(docStatuses(SMS.balance)).toEqual(
      await collect([() => smsMod.handleSmsBalance(deps({ lookupAccount: async () => null }))(LIVE), () => smsMod.handleSmsBalance(deps({ pendingUnits: boom }))(LIVE)])
    )
    expect(docStatuses(SMS.senders)).toEqual(
      await collect([() => smsMod.handleSmsSenders(deps({ lookupAccount: async () => null }))(LIVE), () => smsMod.handleSmsSenders(deps({ listSenders: boom }))(LIVE)])
    )
    expect(docStatuses(SMS.campaigns)).toEqual(
      await collect([
        () => smsMod.handleSmsCampaigns(deps())({ page: "x" }, LIVE),
        () => smsMod.handleSmsCampaigns(deps())({ status: "x" }, LIVE),
        () => smsMod.handleSmsCampaigns(deps({ listCampaigns: boom }))({}, LIVE),
      ])
    )
    expect(docStatuses(SMS.campaign)).toEqual(
      await collect([() => smsMod.handleSmsCampaign(deps())("1", LIVE), () => smsMod.handleSmsCampaign(deps({ getCampaign: boom }))("1", LIVE)])
    )
  })

  it("states the multi-batch rule: campaign_id is the FIRST batch, detail covers that batch only, up to 500 recipients", () => {
    const n = find(SMS.send).notes.join(" ")
    expect(n).toMatch(/campaign_id is the id of the FIRST batch/)
    expect(n).toMatch(/first batch only \(up to 500 recipients\)/)
    expect(find(SMS.campaign).notes.join(" ")).toMatch(/FIRST batch[^.]*that batch only[^.]*500 recipients/)
  })

  it("states created, replay, held, scheduled and partial behaviour", () => {
    const n = find(SMS.send).notes.join(" ")
    expect(n).toMatch(/HTTP 201 with \{ send \}/)
    expect(n).toMatch(/HTTP 200 with \{ send, replayed: true \}/)
    for (const w of ["held", "scheduled", "partial", "stopped_reason", "invalid_skipped", "REFERENCE_REUSED", "OUTCOME_UNKNOWN"]) expect(n).toContain(w)
  })

  it("the hash claim in the docs matches smsHash: reference excluded, sender included", () => {
    const a = smsRules.parseSmsSendBody(goodBody, NOW)
    const b = smsRules.parseSmsSendBody({ ...goodBody, reference: "OTHER-REF" }, NOW)
    const c = smsRules.parseSmsSendBody({ ...goodBody, sender_id: "OTHERBRAND" }, NOW)
    if (!a.ok || !b.ok || !c.ok) throw new Error("parse")
    expect(smsRules.smsHash(a.value)).toBe(smsRules.smsHash(b.value))
    expect(smsRules.smsHash(a.value)).not.toBe(smsRules.smsHash(c.value))
    expect(find(SMS.send).notes.join(" ")).toMatch(/message, recipients, sender_id and scheduled_at; the reference itself is not part/)
  })

  it("documents the sandbox exactly as the handlers behave", async () => {
    const sb = text(prose("sms-sandbox"))
    const sent = await smsMod.handleSmsSend(deps())(goodBody, TEST)
    expect(sent.status).toBe(201)
    expect((sent.data as any).sandbox).toBe(true)
    expect((sent.data as any).send.campaign_id).toBeNull()
    const again = await smsMod.handleSmsSend(deps())(goodBody, TEST)
    expect((again.data as any).replayed).toBeUndefined()
    const bal = await smsMod.handleSmsBalance(deps())(TEST)
    expect((bal.data as any).balance.credits).toBe(1000)
    expect(sb).toContain("1000 credits")
    const snd = await smsMod.handleSmsSenders(deps())(TEST)
    expect((snd.data as any).senders[0].sender_id).toBe("SANDBOX")
    expect(sb).toContain("SANDBOX")
    const list = await smsMod.handleSmsCampaigns(deps())({}, TEST)
    expect((list.data as any).campaigns).toEqual([])
    expect((await smsMod.handleSmsCampaign(deps())("1", TEST)).status).toBe(404)
    expect(sb).toMatch(/empty list/)
    expect(sb).toMatch(/always returns 404/)
    expect(sb).toMatch(/no replay/)
    expect(sb).toMatch(/stateless/)
    // The sandbox does not check recipients, sender ownership or credits (live would answer 400 NO_VALID_RECIPIENTS).
    const allInvalid = await smsMod.handleSmsSend(deps())({ ...goodBody, recipients: ["abc", "12345"] }, TEST)
    expect(allInvalid.status).toBe(201)
    expect(sb).toMatch(/does NOT check recipient validity, sender ownership or credits/)
    expect(sb).toContain("NO_VALID_RECIPIENTS")
  })

  it("documents the partial-send accounting honestly", () => {
    const notes = find(SMS.send).notes.join(" ")
    expect(notes).toMatch(/first batches batches of 500/)
    expect(notes).toMatch(/still occupy a position/)
    expect(notes).toMatch(/Do not blindly re-send the whole list/)
    expect(notes).toMatch(/total counts only the valid numbers/)
    expect(notes).not.toMatch(/do not resend those numbers/)
  })

  it("start prose covers SMS and the auth note says credits, not wallet", () => {
    expect(prose("overview").intro).toMatch(/send SMS/i)
    expect(prose("overview").intro).not.toMatch(/SMS[^.]*not part of this release/i)
    expect(prose("authentication").intro).toMatch(/SMS key[^.]*SMS endpoints/i)
    expect(prose("key-types").intro).toMatch(/SMS keys unlock the SMS endpoints/)
    expect(prose("key-types").intro).not.toMatch(/generated separately from the SMS dashboard/)
    expect(prose("sandbox").intro).toMatch(/SMS/)
    expect(prose("idempotency").intro).toMatch(/SMS/)
    expect(text(prose("sms-overview"))).toMatch(/SMS credits, not your wallet/)
    expect(text(prose("sms-idempotency"))).toMatch(/REFERENCE_REUSED[\s\S]*REQUEST_IN_PROGRESS[\s\S]*OUTCOME_UNKNOWN/)
  })

  it("uses fake data only and leaks no internals", () => {
    const all = JSON.stringify(v2DocsRegistry.filter((s) => s.group === "sms"))
    expect(all).not.toMatch(/api_v2_idempotency|enqueueSendBatched|sms_send_logs|sms_accounts|supabase|unit_balance|sendLogId/i)
    for (const p of all.match(/(\+233|0)\d{9}/g) ?? []) expect(p).toMatch(/^(\+23324400000|024400000)\d$/)
  })
})

describe("sms docs: the reference is only free after genuinely no-charge errors", () => {
  it("no doc text mentions SEND_FAILED or keeping no credits", () => {
    const all = JSON.stringify(v2DocsRegistry)
    expect(all).not.toContain("SEND_FAILED")
    expect(all).not.toContain("no credits were kept")
  })
})
