// app/api/webhooks/hubtel-payments/route.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { NextRequest } from "next/server"
import { signRef } from "@/lib/hubtel-cs/callback"
import type { ConfirmDeps, HubtelPaymentRow, HubtelPaymentStore } from "@/lib/hubtel-pay/confirm"

const h = vi.hoisted(() => ({ confirm: vi.fn() }))
vi.mock("@/lib/hubtel-pay/confirm", () => ({ confirmHubtelPayment: (...a: any[]) => h.confirm(...a) }))

import * as route from "./route"
const { POST } = route

const SECRET = "s".repeat(40)
const REF = "0123456789abcdef0123456789abcdef"
const OTHER = "fedcba9876543210fedcba9876543210"

const req = (q: Record<string, string>, body: unknown = { ResponseCode: "0000", Data: { ClientReference: REF, CustomerPhoneNumber: "233555773910" } }) => {
  const u = new URL("https://www.datagod.store/api/webhooks/hubtel-payments")
  for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v)
  return new NextRequest(u, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), headers: { "content-type": "application/json" } })
}

let logs: string[]
beforeEach(() => {
  h.confirm.mockReset()
  process.env.HUBTEL_PAYMENTS_CALLBACK_SECRET = SECRET
  logs = []
  const cap = (...a: unknown[]) => { logs.push(a.map((x) => (x instanceof Error ? x.message : typeof x === "string" ? x : JSON.stringify(x))).join(" ")) }
  vi.spyOn(console, "log").mockImplementation(cap)
  vi.spyOn(console, "warn").mockImplementation(cap)
  vi.spyOn(console, "error").mockImplementation(cap)
})
afterEach(() => { vi.restoreAllMocks(); delete process.env.HUBTEL_PAYMENTS_CALLBACK_SECRET })

describe("hubtel-payments callback route", () => {
  it("exports only POST plus the Next config consts (no GET → 405)", () => {
    expect(Object.keys(route).sort()).toEqual(["POST", "dynamic", "maxDuration"])
    expect(route.dynamic).toBe("force-dynamic")
    expect(route.maxDuration).toBe(120)
  })

  it("forged sig → 401 and confirm (status check) is never called", async () => {
    const res = await POST(req({ ref: REF, sig: "0".repeat(64) }))
    expect(res.status).toBe(401)
    expect(h.confirm).not.toHaveBeenCalled()
  })

  it("missing sig → 401, no confirm", async () => {
    const res = await POST(req({ ref: REF }))
    expect(res.status).toBe(401)
    expect(h.confirm).not.toHaveBeenCalled()
  })

  it("a valid sig for another reference → 401, no confirm", async () => {
    const res = await POST(req({ ref: REF, sig: signRef(OTHER, SECRET) }))
    expect(res.status).toBe(401)
    expect(h.confirm).not.toHaveBeenCalled()
  })

  it("bad reference format → 401 even with a sig computed for that string", async () => {
    for (const bad of ["WALLET-123", REF.toUpperCase(), REF + "0", ""]) {
      const res = await POST(req({ ref: bad, sig: signRef(bad || "x", SECRET) }))
      expect(res.status).toBe(401)
    }
    expect(h.confirm).not.toHaveBeenCalled()
  })

  it("secret missing or short → 503, nothing done, logged", async () => {
    for (const s of [undefined, "short"]) {
      if (s === undefined) delete process.env.HUBTEL_PAYMENTS_CALLBACK_SECRET
      else process.env.HUBTEL_PAYMENTS_CALLBACK_SECRET = s
      const res = await POST(req({ ref: REF, sig: signRef(REF, s ?? SECRET) }))
      expect(res.status).toBe(503)
    }
    expect(h.confirm).not.toHaveBeenCalled()
    expect(logs.some((l) => l.includes("HUBTEL_PAYMENTS_CALLBACK_SECRET"))).toBe(true)
  })

  it("secret of 31 chars → 503 even with a correctly computed sig; no confirm", async () => {
    const s = "s".repeat(31)
    process.env.HUBTEL_PAYMENTS_CALLBACK_SECRET = s
    const res = await POST(req({ ref: REF, sig: signRef(REF, s) }))
    expect(res.status).toBe(503)
    expect(h.confirm).not.toHaveBeenCalled()
  })

  it("secret of exactly 32 chars → accepted", async () => {
    const s = "s".repeat(32)
    process.env.HUBTEL_PAYMENTS_CALLBACK_SECRET = s
    h.confirm.mockResolvedValue("pending")
    const res = await POST(req({ ref: REF, sig: signRef(REF, s) }))
    expect(res.status).toBe(200)
    expect(h.confirm).toHaveBeenCalledTimes(1)
  })

  it("bad reference with a missing secret → 401 (format is checked first)", async () => {
    delete process.env.HUBTEL_PAYMENTS_CALLBACK_SECRET
    const res = await POST(req({ ref: "WALLET-123", sig: "x" }))
    expect(res.status).toBe(401)
    expect(h.confirm).not.toHaveBeenCalled()
  })

  it("missing secret with a garbage sig → 503, no confirm", async () => {
    delete process.env.HUBTEL_PAYMENTS_CALLBACK_SECRET
    const res = await POST(req({ ref: REF, sig: "garbage" }))
    expect(res.status).toBe(503)
    expect(h.confirm).not.toHaveBeenCalled()
  })

  it("valid sig + unknown reference → 200 { received: true } (confirm returns ignored)", async () => {
    h.confirm.mockResolvedValue("ignored")
    const res = await POST(req({ ref: REF, sig: signRef(REF, SECRET) }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ received: true })
    expect(h.confirm).toHaveBeenCalledTimes(1)
    expect(h.confirm.mock.calls[0][0]).toBe(REF)
  })

  it.each(["fulfilled", "failed", "pending", "needs_review"])("outcome %s → 200 { received: true }", async (o) => {
    h.confirm.mockResolvedValue(o)
    const res = await POST(req({ ref: REF, sig: signRef(REF, SECRET) }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ received: true })
  })

  it("confirm throws → still 200, error logged without phone numbers or raw body", async () => {
    h.confirm.mockRejectedValue(new Error("hubtel_payments load failed: timeout"))
    const res = await POST(req({ ref: REF, sig: signRef(REF, SECRET) }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ received: true })
    expect(logs.some((l) => l.includes("timeout"))).toBe(true)
    expect(logs.join("\n")).not.toContain("233555773910")
    expect(logs.join("\n")).not.toContain("CustomerPhoneNumber")
  })

  it("malformed JSON body with a valid sig → still confirms and answers 200", async () => {
    h.confirm.mockResolvedValue("pending")
    const res = await POST(req({ ref: REF, sig: signRef(REF, SECRET) }, "not json{"))
    expect(res.status).toBe(200)
    expect(h.confirm).toHaveBeenCalledTimes(1)
  })

  it("a body saying Success while the status check says Unpaid → nothing fulfilled", async () => {
    const actual = await vi.importActual<typeof import("@/lib/hubtel-pay/confirm")>("@/lib/hubtel-pay/confirm")
    const row: HubtelPaymentRow = {
      reference: REF, amount_pesewas: 2000, status: "pending", claimed_at: null,
      expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
    }
    const store: HubtelPaymentStore = {
      load: vi.fn(async () => ({ ...row })),
      claim: vi.fn(async () => null),
      update: vi.fn(async () => true),
    }
    const deps: Partial<ConfirmDeps> = {
      store,
      checkStatus: vi.fn(async () => ({ kind: "unpaid" as const, raw: { status: "Unpaid" } })),
      onChargeSuccess: vi.fn(async () => null),
      onChargeFailed: vi.fn(async () => null),
      notify: vi.fn(async () => {}),
    }
    let outcome: string | undefined
    h.confirm.mockImplementation(async (ref: string) => { outcome = await actual.confirmHubtelPayment(ref, deps); return outcome })

    const body = { ResponseCode: "0000", Status: "Success", Data: { ClientReference: REF, Status: "Success", Amount: 20 } }
    const res = await POST(req({ ref: REF, sig: signRef(REF, SECRET) }, body))
    expect(res.status).toBe(200)
    expect(outcome).toBe("pending")
    expect(deps.onChargeSuccess).not.toHaveBeenCalled()
    expect(store.claim).not.toHaveBeenCalled()
  })
})
