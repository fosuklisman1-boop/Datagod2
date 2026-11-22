import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: () => ({
      update: () => ({ eq: async () => ({ error: null }) }),
      select: () => ({ eq: () => ({ single: async () => ({ data: { value: { enabled: true } }, error: null }) }) }),
    }),
  }),
}))

const createMTNOrder = vi.hoisted(() => vi.fn())
vi.mock("@/lib/mtn-fulfillment", () => ({
  isAutoFulfillmentEnabled: vi.fn().mockResolvedValue(true),
  createMTNOrder,
  saveMTNTracking: vi.fn().mockResolvedValue("t"),
  normalizePhoneNumber: (p: string) => p,
}))
const isPhoneBlacklisted = vi.hoisted(() => vi.fn())
vi.mock("@/lib/blacklist", () => ({ isPhoneBlacklisted }))
const createNonMTNOrder = vi.hoisted(() => vi.fn())
vi.mock("@/lib/non-mtn-fulfillment", () => ({ createNonMTNOrder }))
vi.mock("@/lib/sms-service", () => ({ notifyAdmins: vi.fn().mockResolvedValue(undefined) }))

import { fulfillUssdOrder } from "./fulfill"

const PHONE = "0551234567"
let logs: string[]
const spies: any[] = []

beforeEach(() => {
  vi.clearAllMocks()
  isPhoneBlacklisted.mockResolvedValue(false)
  createMTNOrder.mockResolvedValue({ success: true, order_id: "ext-abc", provider: "sykes" })
  createNonMTNOrder.mockResolvedValue({ success: true, provider: "xpress" })
  logs = []
  for (const k of ["log", "warn", "error", "info"] as const) {
    spies.push(
      vi.spyOn(console, k).mockImplementation((...a: unknown[]) => void logs.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "))),
    )
  }
})
afterEach(() => {
  for (const s of spies.splice(0)) s.mockRestore()
})

const flush = () => new Promise((r) => setTimeout(r, 0))

describe("fulfillUssdOrder — logs never carry the recipient phone", () => {
  it("MTN path: no 9+ digit run in any log line, last 3 digits only", async () => {
    const r = await fulfillUssdOrder("order-uuid-a", "MTN", PHONE, "1GB", true, "ussd_orders", "sykes")
    expect(r.success).toBe(true)
    expect(logs.length).toBeGreaterThan(0)
    for (const l of logs) expect(l).not.toMatch(/\d{9,}/)
    expect(logs.join("\n")).toContain("***567")
  })

  it("blacklisted path: the warning is masked too", async () => {
    isPhoneBlacklisted.mockResolvedValue(true)
    await fulfillUssdOrder("order-uuid-b", "MTN", PHONE, "1GB")
    expect(logs.some((l) => l.includes("blacklisted"))).toBe(true)
    for (const l of logs) expect(l).not.toMatch(/\d{9,}/)
  })

  it("non-MTN path: no 9+ digit run in any log line", async () => {
    await fulfillUssdOrder("order-uuid-c", "Telecel", PHONE, "2GB", true)
    await flush()
    expect(createNonMTNOrder).toHaveBeenCalledTimes(1)
    expect(createNonMTNOrder.mock.calls[0][0].phoneNumber).toBe(PHONE) // behaviour unchanged: the real number is still sent
    for (const l of logs) expect(l).not.toMatch(/\d{9,}/)
  })
})
