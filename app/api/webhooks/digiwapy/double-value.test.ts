import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import { deliveredAfterRefund } from "@/lib/airtime-admin-status"

let current: { id: string; status: string } | null = null
const updates: unknown[] = []

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: () => {
      const q: any = {
        select: () => q, eq: () => q,
        update: (patch: unknown) => { updates.push(patch); return q },
        maybeSingle: async () => ({ data: current, error: null }),
        then: (res: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(res),
      }
      return q
    },
  }),
}))
vi.mock("@/lib/digiwapy-provider", () => ({ verifyDigiWapyWebhookSignature: () => true }))
const notifyAdmins = vi.fn(async () => {})
vi.mock("@/lib/sms-service", () => ({ notifyAdmins: (...a: unknown[]) => (notifyAdmins as any)(...a) }))

import { POST } from "./route"

const hook = (event: string) => POST(new NextRequest("http://x/api/webhooks/digiwapy", {
  method: "POST", body: JSON.stringify({ event, data: { reference: "AIR-1" } }), headers: { "x-webhook-signature": "sig" },
}))

beforeEach(() => { notifyAdmins.mockClear(); updates.length = 0 })

describe("Digiwapy webhook: delivery after a storefront refund", () => {
  it("sends an urgent double-value alert when delivery lands on a refunding/refunded order", async () => {
    for (const status of ["refunding", "refunded"]) {
      notifyAdmins.mockClear()
      current = { id: "a1", status }
      expect((await hook("transaction.completed")).status).toBe(200)
      expect(notifyAdmins).toHaveBeenCalledTimes(1)
      expect(notifyAdmins).toHaveBeenCalledWith(expect.stringMatching(/URGENT: double value.*AIR-1.*Digiwapy/), "airtime_double_value", "a1")
    }
  })
  it("no alert for a normal delivery or for a failure on a refunded order", async () => {
    current = { id: "a1", status: "processing" }
    await hook("transaction.completed")
    current = { id: "a1", status: "refunded" }
    await hook("transaction.failed")
    expect(notifyAdmins).not.toHaveBeenCalled()
  })
  it("helper", () => {
    expect(deliveredAfterRefund(true, "refunded")).toBe(true)
    expect(deliveredAfterRefund(true, "completed")).toBe(false)
    expect(deliveredAfterRefund(false, "refunded")).toBe(false)
  })
})
