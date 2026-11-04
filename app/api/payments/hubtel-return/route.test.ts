// app/api/payments/hubtel-return/route.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { NextRequest } from "next/server"
import { signRef } from "@/lib/hubtel-cs/callback"

const h = vi.hoisted(() => ({
  confirm: vi.fn(),
  row: null as null | { internal_reference: string | null; metadata: unknown },
  customDomain: vi.fn(),
}))
vi.mock("@/lib/hubtel-pay/confirm", () => ({ confirmHubtelPayment: (...a: any[]) => h.confirm(...a) }))
vi.mock("@/lib/custom-domain-lookup", () => ({ resolveCustomDomain: (...a: any[]) => h.customDomain(...a) }))
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => {
    const q: any = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: h.row, error: null }) }
    return { from: () => q }
  },
}))

import * as route from "./route"
const { GET } = route

const SECRET = "s".repeat(40)
const REF = "0123456789abcdef0123456789abcdef"
const goodSig = signRef(`return:${REF}`, SECRET)
const req = (q: Record<string, string>) => {
  const u = new URL("https://www.datagod.store/api/payments/hubtel-return")
  for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v)
  return new NextRequest(u, { method: "GET" })
}

beforeEach(() => {
  h.confirm.mockReset().mockResolvedValue("pending")
  h.customDomain.mockReset().mockResolvedValue(null)
  h.row = { internal_reference: "WALLET-123", metadata: { redirect_url: "https://www.datagod.store/dashboard/wallet?reference=WALLET-123" } }
  process.env.HUBTEL_PAYMENTS_CALLBACK_SECRET = SECRET
  process.env.NEXT_PUBLIC_APP_URL = "https://www.datagod.store"
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://x.supabase.co"
  process.env.SUPABASE_SERVICE_ROLE_KEY = "k"
  vi.spyOn(console, "warn").mockImplementation(() => {})
  vi.spyOn(console, "error").mockImplementation(() => {})
})
afterEach(() => { vi.restoreAllMocks(); delete process.env.HUBTEL_PAYMENTS_CALLBACK_SECRET })

describe("hubtel-return route", () => {
  it("exports only GET plus the Next config consts", () => {
    expect(Object.keys(route).sort()).toEqual(["GET", "dynamic", "maxDuration"])
    expect(route.dynamic).toBe("force-dynamic")
    expect(route.maxDuration).toBe(30)
  })

  it("bad signature → 400, no redirect, no confirm", async () => {
    const res = await GET(req({ ref: REF, sig: "0".repeat(64), redirect: "https://evil.com" }))
    expect(res.status).toBe(400)
    expect(res.headers.get("location")).toBeNull()
    expect(h.confirm).not.toHaveBeenCalled()
  })

  it("the callback signature does not open the return route", async () => {
    const res = await GET(req({ ref: REF, sig: signRef(REF, SECRET) }))
    expect(res.status).toBe(400)
  })

  it("good signature → confirm, 302 to the stored URL only", async () => {
    const res = await GET(req({ ref: REF, sig: goodSig }))
    expect(res.status).toBe(302)
    expect(h.confirm).toHaveBeenCalledWith(REF)
    const loc = new URL(res.headers.get("location")!)
    expect(loc.origin + loc.pathname).toBe("https://www.datagod.store/dashboard/wallet")
    expect(loc.searchParams.get("reference")).toBe("WALLET-123")
    expect(loc.searchParams.get("gateway")).toBe("hubtel")
  })

  it("an open-redirect attempt via the query is ignored", async () => {
    const res = await GET(req({ ref: REF, sig: goodSig, redirect_url: "https://evil.com", redirectUrl: "https://evil.com", next: "https://evil.com", url: "https://evil.com" }))
    expect(res.status).toBe(302)
    expect(new URL(res.headers.get("location")!).host).toBe("www.datagod.store")
  })

  it("a stored URL off the allowlist → app home", async () => {
    h.row = { internal_reference: "W", metadata: { redirect_url: "https://evil.com/x" } }
    const res = await GET(req({ ref: REF, sig: goodSig }))
    expect(res.headers.get("location")).toBe("https://www.datagod.store/")
  })

  it("a registered custom domain is allowed", async () => {
    h.customDomain.mockImplementation(async (host: string) => (host === "clingshub.com" ? { domain: host } : null))
    h.row = { internal_reference: "S1", metadata: { redirect_url: "https://clingshub.com/shop/a/payment-confirmation?reference=S1" } }
    const res = await GET(req({ ref: REF, sig: goodSig }))
    expect(new URL(res.headers.get("location")!).host).toBe("clingshub.com")
  })

  it("unknown reference → app home", async () => {
    h.row = null
    const res = await GET(req({ ref: REF, sig: goodSig }))
    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toBe("https://www.datagod.store/")
  })

  it("cancel → same handling", async () => {
    const res = await GET(req({ ref: REF, sig: goodSig, cancelled: "1" }))
    expect(res.status).toBe(302)
    expect(h.confirm).toHaveBeenCalledTimes(1)
  })
})
