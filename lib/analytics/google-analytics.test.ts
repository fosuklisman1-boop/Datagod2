import { afterEach, describe, it, expect, vi } from "vitest"
import vm from "node:vm"
import { GA_MEASUREMENT_ID, gaBootstrapScript, isGaPathAllowed, shouldLoadGa, trackSignUp } from "./google-analytics"

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
  const timers: Array<() => void> = []
  const context = {
    window: win,
    location: { pathname, origin: "https://www.datagod.store" },
    document: {
      createElement: () => ({ src: "", async: false }),
      head: { appendChild: (s: { src: string; async: boolean }) => appended.push(s) },
    },
    Date,
    setTimeout: (fn: () => void) => timers.push(fn),
  }
  vm.runInNewContext(gaBootstrapScript(), context)
  const commands = () => win.dataLayer.map((a: ArrayLike<unknown>) => Array.from(a)) as unknown[][]
  return { win, appended, timers, commands, disabled: () => win[`ga-disable-${GA_MEASUREMENT_ID}`] }
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

describe("sign-up conversion event", () => {
  const signUpEvent = (commands: unknown[][]) => commands.find((c) => c[0] === "event" && c[1] === "sign_up")

  it("sends sign_up with a query-free URL from a private page, then turns collection back off", () => {
    const { win, commands, disabled } = runBootstrap("/mtn-data")
    win.__dgGaSync("/auth/signup")
    expect(disabled()).toBe(true)

    const done = vi.fn()
    win.__dgGaSignUp("email", done)
    expect(disabled()).toBe(false)

    const params = signUpEvent(commands())![2] as Record<string, any>
    expect(params.method).toBe("email")
    expect(params.page_location).toBe("https://www.datagod.store/auth/signup")

    params.event_callback()
    expect(done).toHaveBeenCalledTimes(1)
    expect(disabled()).toBe(true)
  })

  it("loads Google's script without a page view when the visitor opened sign-up directly", () => {
    const { win, appended, commands } = runBootstrap("/auth/signup")
    expect(appended).toHaveLength(0)

    win.__dgGaSignUp("google", () => {})
    expect(appended).toHaveLength(1)
    const config = commands().find((c) => c[0] === "config")!
    expect(config[2]).toEqual({ send_page_view: false })
    expect(signUpEvent(commands())).toBeTruthy()
  })

  it("does not reload Google's script when it is already loaded", () => {
    const { win, appended, commands } = runBootstrap("/mtn-data")
    win.__dgGaSync("/auth/signup")
    win.__dgGaSignUp("email", () => {})
    expect(appended).toHaveLength(1)
    expect(commands().filter((c) => c[0] === "config")).toHaveLength(1)
  })

  it("still finishes, once, if Google never answers", () => {
    const { win, timers, commands, disabled } = runBootstrap("/auth/signup")
    const done = vi.fn()
    win.__dgGaSignUp("email", done)
    expect(done).not.toHaveBeenCalled()

    timers.forEach((fn) => fn())
    expect(done).toHaveBeenCalledTimes(1)
    expect(disabled()).toBe(true)

    ;(signUpEvent(commands())![2] as Record<string, any>).event_callback()
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

  it("resolves on the server", async () => {
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
