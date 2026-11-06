// A USSD AFA order waiting on a Paystack OTP: a redial finds it and the code goes to the shared OTP step.
import { beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({ sessions: new Map<string, any>() }))

vi.mock("@supabase/supabase-js", async () => (await import("@/lib/ussd/gateway-test-kit")).supabaseMock())
vi.mock("./session", () => ({
  getSession: vi.fn(async (id: string) => h.sessions.get(id) ?? null),
  setSession: vi.fn(async (id: string, s: any) => { h.sessions.set(id, s) }),
  deleteSession: vi.fn(async () => {}),
  isRedisConfigured: () => true,
}))
vi.mock("./bots/otp-redial", () => ({ botOtpCandidate: vi.fn(async () => null), handleBotOtpRedial: vi.fn() }))
vi.mock("./handlers/main", () => ({ handleMain: vi.fn(), mainMenuVisibility: vi.fn(async () => ({})) }))

import { router } from "./router"
import { kit, resetKit, rows } from "./gateway-test-kit"

const DIAL = "+233244123499"
const dial = (sessionID: string, ussdServiceOp: string, ussdString = "") =>
  router({ sessionID, ussdServiceOp, ussdString, msisdn: DIAL } as any)
const waiting = (o: Record<string, unknown> = {}) => ({
  id: "afa-1", dialing_phone: DIAL, payment_status: "otp_required", order_status: "pending", created_at: new Date().toISOString(), ...o,
})

beforeEach(() => {
  resetKit()
  h.sessions.clear()
  vi.spyOn(console, "log").mockImplementation(() => {})
})

describe("USSD AFA OTP redial", () => {
  it("a redial asks for the OTP and points the session at the AFA order", async () => {
    kit.db.ussd_afa_orders = [waiting()]
    const res = await dial("S1", "1")
    expect(res.message).toContain("Enter the OTP")
    expect(h.sessions.get("S1")).toMatchObject({ step: "SUBMIT_OTP", pendingOrderId: "afa-1", pendingOrderTable: "ussd_afa_orders" })
  })

  it("an order past the 10-minute window is not resumed", async () => {
    kit.db.ussd_afa_orders = [waiting({ created_at: "2026-01-01T00:00:00.000Z" })]
    await dial("S1", "1")
    expect(h.sessions.get("S1")).toMatchObject({ step: "MAIN" })
  })

  it("the OTP step works on the AFA table, never ussd_orders", async () => {
    kit.db.ussd_afa_orders = [waiting()]
    h.sessions.set("S1", { step: "SUBMIT_OTP", dialingPhone: DIAL, pendingOrderId: "afa-1", pendingOrderTable: "ussd_afa_orders" })
    await dial("S1", "2", "0")
    expect(rows("ussd_afa_orders")[0]).toMatchObject({ payment_status: "failed", order_status: "failed" })
    expect(kit.ops).not.toContainEqual(["ussd_orders", "update"])
  })
})
