import { describe, expect, it } from "vitest"
import { connectErrorMessage } from "./connect-errors"

const named = (name: string) => Object.assign(new Error("x"), { name })

describe("connectErrorMessage", () => {
  it.each(["credits", "busy", "unavailable", "review_pending"] as const)("maps %s to busy copy", (r) => {
    expect(connectErrorMessage(undefined, r)).toBe("Calls are busy right now — you can keep chatting here.")
  })
  it("maps daily_cap", () => {
    expect(connectErrorMessage(undefined, "daily_cap")).toBe("You've used today's calls. You can keep chatting here.")
  })
  it("maps visitor_cap", () => {
    expect(connectErrorMessage(undefined, "visitor_cap")).toBe("Calls are full for today. Sign in to call, or keep chatting here.")
  })
  it("maps policy", () => {
    expect(connectErrorMessage(undefined, "policy")).toBe("Calls are paused for this account for a while.")
  })
  it("maps PolicyCurfewError like policy", () => {
    expect(connectErrorMessage(named("PolicyCurfewError"))).toBe("Calls are paused for this account for a while.")
  })
  it("maps MediaAccessError", () => {
    expect(connectErrorMessage(named("MediaAccessError"))).toBe("Allow the microphone (and camera for video) to call.")
  })
  it("maps WebRTCUnavailableError", () => {
    expect(connectErrorMessage(named("WebRTCUnavailableError"))).toBe("This browser can't make calls. Try Chrome, or keep chatting here.")
  })
  it("maps JoinTimeoutError", () => {
    expect(connectErrorMessage(named("JoinTimeoutError"))).toBe("Couldn't connect the call. A VPN or data saver can block calls.")
  })
  it("falls back for anything else", () => {
    const generic = "Couldn't start the call — keep chatting here."
    expect(connectErrorMessage(new Error("boom"))).toBe(generic)
    expect(connectErrorMessage(null)).toBe(generic)
    expect(connectErrorMessage(undefined, "bot")).toBe(generic)
    expect(connectErrorMessage(named("ApiError"))).toBe(generic)
  })
})
