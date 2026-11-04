import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const h = vi.hoisted(() => ({ count: vi.fn(), settings: vi.fn(), mode: "platform" as string }))

vi.mock("@/lib/sms/tenant-auth", () => ({
  resolveAccount: () => Promise.resolve({ account: { id: "acc1", mode: h.mode }, user: { id: "u1" } }),
}))
vi.mock("@/lib/sms/tenant-address-book-service", () => ({ getGroupActiveCount: h.count }))
vi.mock("@/lib/sms/platform-settings", () => ({ loadSmsSettings: h.settings }))

import { GET } from "./route"

const CAPS = { caps: { platform: { per_send: 2000, per_hour: 1, per_day: 1 }, business: { per_send: 10000, per_hour: 1, per_day: 1 } } }
const get = () => GET(new NextRequest("http://localhost/api/sms/groups/g1/preview"), { params: Promise.resolve({ id: "g1" }) })

beforeEach(() => {
  h.count.mockReset(); h.count.mockResolvedValue({ ok: true, data: { activeCount: 3000, sentCount: 2000 } })
  h.settings.mockReset(); h.settings.mockResolvedValue(CAPS)
  h.mode = "platform"
})

describe("GET /api/sms/groups/[id]/preview", () => {
  it("caps sentCount at the account's admin per-send limit", async () => {
    const res = await get()
    expect(res.status).toBe(200)
    expect(h.count).toHaveBeenCalledWith("acc1", "g1", 2000)
  })
  it("never above the 5,000 ceiling (business cap 10,000)", async () => {
    h.mode = "business"
    await get()
    expect(h.count).toHaveBeenCalledWith("acc1", "g1", 5000)
  })
})
