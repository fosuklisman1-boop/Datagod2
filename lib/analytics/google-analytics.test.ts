import { describe, it, expect } from "vitest"
import vm from "node:vm"
import { GA_MEASUREMENT_ID, gaBootstrapScript, isGaPathAllowed, shouldLoadGa } from "./google-analytics"

describe("shouldLoadGa", () => {
  const prod = { vercelEnv: "production", rootDomain: "datagod.store" }

  it("loads on the production main site", () => {
    expect(shouldLoadGa({ ...prod, host: "www.datagod.store" })).toBe(true)
    expect(shouldLoadGa({ ...prod, host: "datagod.store" })).toBe(true)
  })

  it("stays off on shop subdomains and custom domains", () => {
    expect(shouldLoadGa({ ...prod, host: "amashop.datagod.store" })).toBe(false)
    expect(shouldLoadGa({ ...prod, host: "resellerdata.com" })).toBe(false)
  })

  it("stays off outside production", () => {
    expect(shouldLoadGa({ host: "www.datagod.store", vercelEnv: "preview", rootDomain: "datagod.store" })).toBe(false)
    expect(shouldLoadGa({ host: "localhost:3000", vercelEnv: undefined, rootDomain: "datagod.store" })).toBe(false)
  })

  it("stays off without a host", () => {
    expect(shouldLoadGa({ ...prod, host: null })).toBe(false)
  })
})

describe("isGaPathAllowed", () => {
  it.each(["/", "/mtn-data", "/cheapest-data-ghana", "/guides/buy-data-with-momo", "/join"])("allows %s", (p) => {
    expect(isGaPathAllowed(p)).toBe(true)
  })

  it.each(["/admin", "/admin/settings", "/auth/login", "/auth/reset-password", "/dashboard", "/dashboard/wallet", "/shop/ama/order-confirmation/123", "/api/x"])(
    "blocks %s",
    (p) => {
      expect(isGaPathAllowed(p)).toBe(false)
    },
  )

  it("matches whole path segments only", () => {
    expect(isGaPathAllowed("/shopping-tips")).toBe(true)
    expect(isGaPathAllowed("/authors")).toBe(true)
  })
})

/** Runs the real inline script against a minimal fake browser. */
function runBootstrap(pathname: string) {
  const appended: Array<{ src: string; async: boolean }> = []
  const win: Record<string, any> = {}
  const context = {
    window: win,
    location: { pathname },
    document: {
      createElement: () => ({ src: "", async: false }),
      head: { appendChild: (s: { src: string; async: boolean }) => appended.push(s) },
    },
    Date,
  }
  vm.runInNewContext(gaBootstrapScript(), context)
  return { win, appended, disabled: () => win[`ga-disable-${GA_MEASUREMENT_ID}`] }
}

describe("gaBootstrapScript", () => {
  it("uses the owner's measurement id", () => {
    expect(GA_MEASUREMENT_ID).toBe("G-2K4DGTV07P")
  })

  it("loads gtag.js and configures GA on an allowed page", () => {
    const { win, appended, disabled } = runBootstrap("/mtn-data")
    expect(appended).toHaveLength(1)
    expect(appended[0].src).toBe(`https://www.googletagmanager.com/gtag/js?id=${GA_MEASUREMENT_ID}`)
    expect(appended[0].async).toBe(true)
    expect(disabled()).toBe(false)
    const commands = win.dataLayer.map((a: ArrayLike<unknown>) => Array.from(a))
    expect(commands.map((c: unknown[]) => c[0])).toEqual(["js", "config"])
    expect(commands[1][1]).toBe(GA_MEASUREMENT_ID)
  })

  it("never loads Google's script when a private page is opened directly", () => {
    const { win, appended, disabled } = runBootstrap("/auth/reset-password")
    expect(appended).toHaveLength(0)
    expect(disabled()).toBe(true)
    expect(win.dataLayer).toHaveLength(0)
  })

  it("stops collection when navigating to a private page and resumes without reloading", () => {
    const { win, appended, disabled } = runBootstrap("/")
    win.__dgGaSync("/dashboard")
    expect(disabled()).toBe(true)
    win.__dgGaSync("/mtn-data")
    expect(disabled()).toBe(false)
    expect(appended).toHaveLength(1)
  })

  it("loads once when a visitor moves from a private page to a public one", () => {
    const { win, appended, disabled } = runBootstrap("/dashboard")
    expect(appended).toHaveLength(0)
    win.__dgGaSync("/mtn-data")
    expect(appended).toHaveLength(1)
    expect(disabled()).toBe(false)
  })
})
