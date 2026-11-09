import { describe, it, expect, vi } from "vitest"
import { resolveHubtelReturn, safeReturnTarget, type ReturnDeps } from "./return"
import { hubtelReturnUrl, hubtelCallbackUrl, verifyReturnSig } from "./client"
import { signRef, verifySig } from "@/lib/hubtel-cs/callback"

const REF = "0123456789abcdef0123456789abcdef"
const SECRET = "s".repeat(40)
const ENV = { HUBTEL_PAYMENTS_CALLBACK_SECRET: SECRET, NEXT_PUBLIC_APP_URL: "https://www.datagod.store" }
const HOME = "https://www.datagod.store/"
const sig = signRef(`return:${REF}`, SECRET)

describe("hubtelReturnUrl / verifyReturnSig", () => {
  it("builds a signed return URL on the app host; cancel adds cancelled=1 with the same signature", () => {
    const u = new URL(hubtelReturnUrl(REF, false, ENV))
    expect(u.origin).toBe("https://www.datagod.store")
    expect(u.pathname).toBe("/api/payments/hubtel-return")
    expect(u.searchParams.get("ref")).toBe(REF)
    expect(u.searchParams.get("cancelled")).toBeNull()
    expect(verifyReturnSig(REF, u.searchParams.get("sig"), SECRET)).toBe(true)
    const c = new URL(hubtelReturnUrl(REF, true, ENV))
    expect(c.searchParams.get("cancelled")).toBe("1")
    expect(c.searchParams.get("sig")).toBe(u.searchParams.get("sig"))
  })

  it("return and callback signatures are not interchangeable", () => {
    const ret = new URL(hubtelReturnUrl(REF, false, ENV)).searchParams.get("sig")
    const cb = new URL(hubtelCallbackUrl(REF, ENV)).searchParams.get("sig")
    expect(ret).not.toBe(cb)
    expect(verifySig(REF, ret, SECRET)).toBe(false)
    expect(verifyReturnSig(REF, cb, SECRET)).toBe(false)
  })

  it("throws on a bad reference, a short secret or a non-https app URL", () => {
    expect(() => hubtelReturnUrl("WALLET-1", false, ENV)).toThrow()
    expect(() => hubtelReturnUrl(REF, false, { ...ENV, HUBTEL_PAYMENTS_CALLBACK_SECRET: "x".repeat(31) })).toThrow(/SECRET/)
    expect(() => hubtelReturnUrl(REF, false, { ...ENV, NEXT_PUBLIC_APP_URL: "http://www.datagod.store" })).toThrow(/NEXT_PUBLIC_APP_URL/)
  })
})

describe("safeReturnTarget", () => {
  const custom = vi.fn(async (host: string) => host === "clingshub.com" || host === "shop.clingshub.com")
  const opts = { env: ENV, isCustomDomain: custom }

  it.each([
    "https://www.datagod.store/dashboard/wallet?reference=W1",
    "https://datagod.store/x",
    "https://myshop.datagod.store/shop/myshop/order-confirmation/1?reference=W1",
    "https://clingshub.com/shop/a/payment-confirmation",
    "https://shop.clingshub.com/p",
  ])("allows %s", async (raw) => {
    expect((await safeReturnTarget(raw, opts))?.href).toBe(new URL(raw).href)
  })

  it.each([
    "http://www.datagod.store/dashboard/wallet",
    "https://evil.com/x",
    "https://datagod.store.evil.com/x",
    "https://evildatagod.store/x",
    "https://user:pw@www.datagod.store/x",
    "https://www.datagod.store:8443/x",
    "javascript:alert(1)",
    "//evil.com/x",
    "/dashboard/wallet",
    "not a url",
    "",
    null,
    42,
  ])("rejects %s", async (raw) => {
    expect(await safeReturnTarget(raw as any, opts)).toBeNull()
  })

  it("a custom-domain lookup that throws is a rejection", async () => {
    expect(await safeReturnTarget("https://other.com/x", { env: ENV, isCustomDomain: async () => { throw new Error("redis") } })).toBeNull()
  })
})

function deps(over: Partial<ReturnDeps> = {}) {
  const confirm = vi.fn(async (_r: string) => "pending" as const)
  const loadRow = vi.fn(async (_r: string) => ({
    internal_reference: "WALLET-123",
    metadata: { redirect_url: "https://www.datagod.store/dashboard/wallet?reference=WALLET-123", gateway: "hubtel" },
  }) as { internal_reference: string | null; metadata: unknown } | null)
  const d: Partial<ReturnDeps> = { confirm, loadRow, isCustomDomain: async () => false, env: ENV, ...over }
  return { d, confirm, loadRow }
}

describe("resolveHubtelReturn", () => {
  it("bad or missing signature → bad_request, nothing confirmed or loaded", async () => {
    for (const q of [{ ref: REF, sig: "0".repeat(64) }, { ref: REF, sig: null }, { ref: null, sig }, { ref: "x", sig },
      { ref: REF, sig: signRef(REF, SECRET) }]) {
      const t = deps()
      expect(await resolveHubtelReturn(q, t.d)).toEqual({ kind: "bad_request" })
      expect(t.confirm).not.toHaveBeenCalled()
      expect(t.loadRow).not.toHaveBeenCalled()
    }
  })

  it("no secret configured → not_configured", async () => {
    const t = deps({ env: { NEXT_PUBLIC_APP_URL: "https://www.datagod.store" } })
    expect(await resolveHubtelReturn({ ref: REF, sig }, t.d)).toEqual({ kind: "not_configured" })
  })

  it("good signature → confirm once, redirect to the stored URL with reference, trxref and gateway", async () => {
    const t = deps()
    const out = await resolveHubtelReturn({ ref: REF, sig }, t.d)
    expect(t.confirm).toHaveBeenCalledWith(REF)
    expect(out.kind).toBe("redirect")
    const u = new URL((out as any).url)
    expect(u.origin + u.pathname).toBe("https://www.datagod.store/dashboard/wallet")
    expect(u.searchParams.getAll("reference")).toEqual(["WALLET-123"])
    expect(u.searchParams.get("trxref")).toBe("WALLET-123")
    expect(u.searchParams.get("gateway")).toBe("hubtel")
    expect(u.href).not.toContain(REF)
  })

  it("a slow confirm does not hold the redirect past 5 seconds", async () => {
    vi.useFakeTimers()
    try {
      const t = deps({ confirm: () => new Promise(() => {}) })
      let out: any = null
      const run = resolveHubtelReturn({ ref: REF, sig }, t.d).then((r) => { out = r })
      await vi.advanceTimersByTimeAsync(4_999)
      expect(out).toBeNull()
      await vi.advanceTimersByTimeAsync(1)
      await run
      expect(out.kind).toBe("redirect")
    } finally {
      vi.useRealTimers()
    }
  })

  it("a confirm that throws still redirects", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    const t = deps({ confirm: async () => { throw new Error("relay down") } })
    const out = await resolveHubtelReturn({ ref: REF, sig }, t.d)
    err.mockRestore()
    expect((out as any).url).toContain("/dashboard/wallet")
  })

  it("unknown reference → app home", async () => {
    const t = deps({ loadRow: async () => null })
    expect(await resolveHubtelReturn({ ref: REF, sig }, t.d)).toEqual({ kind: "redirect", url: HOME })
  })

  it("a row lookup that throws → app home", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    const t = deps({ loadRow: async () => { throw new Error("db") } })
    expect(await resolveHubtelReturn({ ref: REF, sig }, t.d)).toEqual({ kind: "redirect", url: HOME })
    err.mockRestore()
  })

  it.each([
    ["off-allowlist host", { redirect_url: "https://evil.com/steal" }],
    ["http", { redirect_url: "http://www.datagod.store/dashboard/wallet" }],
    ["missing", {}],
    ["metadata null", null],
  ])("stored URL %s → app home", async (_n, metadata) => {
    const t = deps({ loadRow: async () => ({ internal_reference: "W", metadata }) })
    expect(await resolveHubtelReturn({ ref: REF, sig }, t.d)).toEqual({ kind: "redirect", url: HOME })
  })

  it("a stored custom-domain URL is allowed", async () => {
    const t = deps({
      isCustomDomain: async (h) => h === "clingshub.com",
      loadRow: async () => ({ internal_reference: "S1", metadata: { redirect_url: "https://clingshub.com/shop/a/payment-confirmation?reference=S1" } }),
    })
    const out: any = await resolveHubtelReturn({ ref: REF, sig }, t.d)
    expect(new URL(out.url).host).toBe("clingshub.com")
  })

  it("cancelled changes nothing about confirmation or the target", async () => {
    const t = deps()
    const out: any = await resolveHubtelReturn({ ref: REF, sig, cancelled: true }, t.d)
    expect(t.confirm).toHaveBeenCalledTimes(1)
    expect(out.url).toContain("/dashboard/wallet")
  })

  it("a null internal_reference falls back to the opaque reference", async () => {
    const t = deps({ loadRow: async () => ({ internal_reference: null, metadata: { redirect_url: "https://www.datagod.store/x" } }) })
    const out: any = await resolveHubtelReturn({ ref: REF, sig }, t.d)
    expect(new URL(out.url).searchParams.get("reference")).toBe(REF)
  })
})
