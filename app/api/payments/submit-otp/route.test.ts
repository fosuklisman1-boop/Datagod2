import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

// Hubtel never returns send_otp, so the web modal never posts a Hubtel reference here. This pins the server side too:
// a Hubtel payment's reference can't reach Paystack's submit_otp, and can't fail its order or payment row.

const h = vi.hoisted(() => {
  const state = {
    payment: null as { payment_method: string } | null,
    updates: [] as { table: string; patch: any }[],
  }
  const chain = (table: string) => {
    const c: any = {}
    let patch: any = null
    for (const m of ["select", "eq", "in"]) c[m] = () => c
    c.maybeSingle = async () => ({ data: table === "wallet_payments" ? state.payment : null, error: null })
    c.update = (p: any) => (patch = p, c)
    c.then = (res: any, rej: any) => {
      if (patch) state.updates.push({ table, patch })
      return Promise.resolve({ data: null, error: null }).then(res, rej)
    }
    return c
  }
  return { state, fake: { from: chain } }
})

vi.mock("@supabase/supabase-js", () => ({ createClient: () => h.fake }))
const submitOtp = vi.fn(async (_r: string, _o: string) => ({ status: "success" }))
vi.mock("@/lib/paystack", () => ({ submitOtp: (r: string, o: string) => submitOtp(r, o) }))
vi.mock("@/lib/rate-limiter", () => ({ applyRateLimit: async () => ({ allowed: true, resetAt: Date.now() }) }))

import { POST } from "./route"

const post = (body: Record<string, unknown>) =>
  POST(new NextRequest("http://x/api/payments/submit-otp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }))

beforeEach(() => {
  h.state.payment = null
  h.state.updates = []
  submitOtp.mockReset()
  submitOtp.mockImplementation(async () => ({ status: "success" }))
})

describe("payments/submit-otp", () => {
  it("a Hubtel payment's reference is refused: Paystack not called, nothing marked failed", async () => {
    h.state.payment = { payment_method: "hubtel" }
    const res = await post({ reference: "WALLET-1-ABCD", otp: "123456", orderId: "o1", orderType: "data" })
    expect(res.status).toBe(400)
    expect((await res.json()).success).toBe(false)
    expect(submitOtp).not.toHaveBeenCalled()
    expect(h.state.updates).toHaveLength(0)
  })

  it("a Paystack payment's reference goes to Paystack as today", async () => {
    h.state.payment = { payment_method: "paystack" }
    const res = await post({ reference: "WALLET-1-ABCD", otp: "123456" })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, status: "success" })
    expect(submitOtp).toHaveBeenCalledWith("WALLET-1-ABCD", "123456")
  })

  it("no payment row found: unchanged, goes to Paystack", async () => {
    await post({ reference: "WALLET-1-ABCD", otp: "123456" })
    expect(submitOtp).toHaveBeenCalledTimes(1)
  })
})
