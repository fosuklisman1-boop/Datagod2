import { afterEach, describe, it, expect, vi } from "vitest"
import vm from "node:vm"
import {
  GA_MEASUREMENT_ID,
  gaBootstrapScript,
  isGaPathAllowed,
  shouldLoadGa,
  shouldReportSignUp,
  trackSignUp,
} from "./google-analytics"

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
  it.each(["/", "/mtn-data", "/cheapest-data-ghana", "/guides/buy-data-with-momo", "/join", "/auth/signup", "/auth/complete-profile"])(
    "allows %s",
    (p) => {
      expect(isGaPathAllowed(p)).toBe(true)
    },
  )

  it.each([
    "/admin",
    "/admin/settings",
    "/auth/login",
    "/auth/reset-password",
    "/auth/callback",
    "/auth/signup/extra",
    "/dashboard",
    "/dashboard/wallet",
    "/shop/ama/order-confirmation/123",
    "/api/x",
  ])("blocks %s", (p) => {
    expect(isGaPathAllowed(p)).toBe(false)
  })

  it("matches whole path segments only", () => {
    expect(isGaPathAllowed("/shopping-tips")).toBe(true)
    expect(isGaPathAllowed("/authors")).toBe(true)
  })
})

describe("shouldReportSignUp", () => {
  it("reports a new account", () => {
    expect(shouldReportSignUp({ identities: [{ provider: "email" }] })).toBe(true)
  })

  it("skips Supabase's look-alike success for an email that is already registered", () => {
    expect(shouldReportSignUp({ identities: [] })).toBe(false)
  })

  it("skips when there is no user", () => {
    expect(shouldReportSignUp(null)).toBe(false)
    expect(shouldReportSignUp(undefined)).toBe(false)
  })

  it("reports when Supabase does not say", () => {
    expect(shouldReportSignUp({})).toBe(true)
  })
})

/** Runs the real inline script against a minimal fake browser. */
function runBootstrap(pathname: string, search = "") {
  const appended: Array<{ src: string; async: boolean }> = []
  const win: Record<string, any> = {}
  const timers: Array<() => void> = []
  const location = { pathname, search, origin: "https://www.datagod.store" }
  const context = {
    window: win,
    location,
    URLSearchParams,
    document: {
      createElement: () => ({ src: "", async: false }),
      head: { appendChild: (s: { src: string; async: boolean }) => appended.push(s) },
    },
    Date,
    setTimeout: (fn: () => void) => timers.push(fn),
  }
  vm.runInNewContext(gaBootstrapScript(), context)
  const commands = () => (win.dataLayer ?? []).map((a: ArrayLike<unknown>) => Array.from(a)) as unknown[][]
  return { win, appended, timers, commands, location, disabled: () => win[`ga-disable-${GA_MEASUREMENT_ID}`] }
}

const configOf = (commands: unknown[][]) => commands.find((c) => c[0] === "config")
const signUpEvent = (commands: unknown[][]) => commands.find((c) => c[0] === "event" && c[1] === "sign_up")

describe("gaBootstrapScript", () => {
  it("uses the owner's measurement id", () => {
    expect(GA_MEASUREMENT_ID).toBe("G-2K4DGTV07P")
  })

  it("loads gtag.js and configures GA normally on a public page", () => {
    const { appended, commands, disabled } = runBootstrap("/mtn-data", "?utm_source=google")
    expect(appended).toHaveLength(1)
    expect(appended[0].src).toBe(`https://www.googletagmanager.com/gtag/js?id=${GA_MEASUREMENT_ID}`)
    expect(appended[0].async).toBe(true)
    expect(disabled()).toBe(false)
    expect(commands().map((c) => c[0])).toEqual(["js", "config"])
    expect(configOf(commands())).toEqual(["config", GA_MEASUREMENT_ID])
  })

  it("never loads Google's script when a private page is opened directly", () => {
    const { appended, commands, disabled } = runBootstrap("/auth/reset-password", "?token=secret")
    expect(appended).toHaveLength(0)
    expect(disabled()).toBe(true)
    expect(commands()).toHaveLength(0)
  })

  it("loads on the sign-up page with the URL trimmed to the path and ad tags", () => {
    const { appended, commands, disabled } = runBootstrap("/auth/signup", "?redirect=%2Fdashboard%2Fwallet&gclid=abc&utm_campaign=mtn&email=x%40y.com")
    expect(appended).toHaveLength(1)
    expect(disabled()).toBe(false)
    const config = configOf(commands())!
    expect(config[2]).toEqual({ page_location: "https://www.datagod.store/auth/signup?gclid=abc&utm_campaign=mtn" })
  })

  it("trims Google profile completion the same way", () => {
    const { commands } = runBootstrap("/auth/complete-profile", "?next=%2Fdashboard")
    expect(configOf(commands())![2]).toEqual({ page_location: "https://www.datagod.store/auth/complete-profile" })
  })

  it("stops collection when navigating to a private page and resumes without reloading", () => {
    const { win, appended, disabled } = runBootstrap("/")
    win.__dgGaSync("/dashboard")
    expect(disabled()).toBe(true)
    win.__dgGaSync("/mtn-data")
    expect(disabled()).toBe(false)
    win.__dgGaSync("/auth/signup")
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

describe("sign-up conversion event", () => {
  it("sends sign_up with the trimmed URL and calls back once", () => {
    const { win, commands, location } = runBootstrap("/mtn-data")
    location.pathname = "/auth/signup"
    location.search = "?redirect=%2Fdashboard&gclid=abc"
    win.__dgGaSync("/auth/signup")

    const done = vi.fn()
    win.__dgGaSignUp("email", done)
    const params = signUpEvent(commands())![2] as Record<string, any>
    expect(params.method).toBe("email")
    expect(params.page_location).toBe("https://www.datagod.store/auth/signup?gclid=abc")

    params.event_callback()
    params.event_callback()
    expect(done).toHaveBeenCalledTimes(1)
  })

  it("finishes, once, if Google never answers", () => {
    const { win, timers, commands } = runBootstrap("/auth/complete-profile")
    const done = vi.fn()
    win.__dgGaSignUp("google", done)
    expect(done).not.toHaveBeenCalled()

    timers.forEach((fn) => fn())
    expect(done).toHaveBeenCalledTimes(1)
    ;(signUpEvent(commands())![2] as Record<string, any>).event_callback()
    expect(done).toHaveBeenCalledTimes(1)
  })

  it("arms the fallback before calling gtag, so a throwing gtag still finishes", () => {
    const { win, timers } = runBootstrap("/auth/signup")
    win.gtag = () => {
      throw new Error("blocked")
    }
    const done = vi.fn()
    expect(() => win.__dgGaSignUp("email", done)).toThrow()
    timers.forEach((fn) => fn())
    expect(done).toHaveBeenCalledTimes(1)
  })

  it("sends nothing from a private page", () => {
    const { win, commands, location } = runBootstrap("/mtn-data")
    location.pathname = "/dashboard"
    win.__dgGaSync("/dashboard")
    const done = vi.fn()
    win.__dgGaSignUp("email", done)
    expect(signUpEvent(commands())).toBeUndefined()
    expect(done).toHaveBeenCalledTimes(1)
  })
})

describe("trackSignUp", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("resolves when analytics is not on this site", async () => {
    vi.stubGlobal("window", {})
    await expect(trackSignUp("email")).resolves.toBeUndefined()
  })

  it("resolves once analytics has finished sending", async () => {
    const sent = vi.fn((_m: string, done: () => void) => done())
    vi.stubGlobal("window", { __dgGaSignUp: sent })
    await trackSignUp("google")
    expect(sent).toHaveBeenCalledWith("google", expect.any(Function))
  })

  it("never lets an analytics failure break sign-up", async () => {
    vi.stubGlobal("window", {
      __dgGaSignUp: () => {
        throw new Error("blocked")
      },
    })
    await expect(trackSignUp("email")).resolves.toBeUndefined()
  })
})
