import { describe, expect, it } from "vitest"
import {
  eventFromResendResponse,
  eventFromStartResponse,
  eventFromVerifyResponse,
  initialPanelState,
  panelReducer,
  type PanelEvent,
  type PanelState,
} from "./panel-state"

const run = (s: PanelState, ...events: PanelEvent[]) => events.reduce(panelReducer, s)

const onCodeScreen = () =>
  run(
    initialPanelState(),
    { type: "availability", enabled: true },
    { type: "edit", field: "password", value: "hunter2" },
    eventFromStartResponse(200, { challenge: { id: "c1", maskedPhone: "024 *** 1234" } }),
  )

describe("phone login panel state", () => {
  it("hides the tab unless GET says enabled", () => {
    expect(initialPanelState().visible).toBe(false)
    expect(run(initialPanelState(), { type: "availability", enabled: false }).visible).toBe(false)
    expect(run(initialPanelState(), { type: "availability", enabled: null }).visible).toBe(false)
    expect(run(initialPanelState(), { type: "availability", enabled: true }).visible).toBe(true)
  })

  it("shows the code screen with the masked phone on a challenge response", () => {
    const s = onCodeScreen()
    expect(s.phase).toBe("code")
    expect(s.challenge).toEqual({ id: "c1", maskedPhone: "024 *** 1234" })
    expect(s.resendSeconds).toBe(60)
  })

  it("410 returns to the form with password cleared and a message", () => {
    const s = run(onCodeScreen(), eventFromVerifyResponse(410, { error: "This sign-in has expired. Please start again." }))
    expect(s.phase).toBe("form")
    expect(s.password).toBe("")
    expect(s.challenge).toBeNull()
    expect(s.message).toBe("This sign-in has expired. Please start again.")
  })

  it("a resend 410 also restarts", () => {
    const s = run(onCodeScreen(), eventFromResendResponse(410, { error: "expired" }))
    expect(s.phase).toBe("form")
    expect(s.password).toBe("")
  })

  it("a session response becomes signedIn carrying the session", () => {
    const session = { access_token: "a", refresh_token: "b" }
    const s = run(onCodeScreen(), eventFromVerifyResponse(200, { session }))
    expect(s.phase).toBe("signedIn")
    expect(s.session).toEqual(session)
    const direct = run(initialPanelState(), eventFromStartResponse(200, { session }))
    expect(direct.phase).toBe("signedIn")
  })

  it("503 on step 1 sets the message and focusEmail", () => {
    const s = run(initialPanelState(), eventFromStartResponse(503, { error: "Try email instead." }))
    expect(s.phase).toBe("form")
    expect(s.focusEmail).toBe(true)
    expect(s.message).toBe("Try email instead.")
  })

  it("401 stays on the form with the error", () => {
    const s = run(initialPanelState(), eventFromStartResponse(401, { error: "Invalid phone or password." }))
    expect(s.phase).toBe("form")
    expect(s.focusEmail).toBe(false)
    expect(s.message).toBe("Invalid phone or password.")
  })

  it("resend 429 with seconds starts a countdown that ticks down", () => {
    let s = run(onCodeScreen(), eventFromResendResponse(429, { error: "wait", seconds: 42 }))
    expect(s.phase).toBe("code")
    expect(s.resendSeconds).toBe(42)
    s = run(s, { type: "tick" })
    expect(s.resendSeconds).toBe(41)
    expect(run({ ...s, resendSeconds: 0 }, { type: "tick" }).resendSeconds).toBe(0)
  })

  it("400 stays on the code screen with attemptsLeft and clears the code", () => {
    const s = run(
      onCodeScreen(),
      { type: "edit", field: "code", value: "123456" },
      eventFromVerifyResponse(400, { error: "That code is not right.", attemptsLeft: 2 }),
    )
    expect(s.phase).toBe("code")
    expect(s.attemptsLeft).toBe(2)
    expect(s.code).toBe("")
    expect(s.message).toBe("That code is not right.")
  })

  it("use a different number returns to the form and clears password and code", () => {
    const s = run(onCodeScreen(), { type: "back" })
    expect(s.phase).toBe("form")
    expect(s.password).toBe("")
    expect(s.challenge).toBeNull()
  })

  it("an unreadable response maps to a generic message and stays put", () => {
    const s = run(onCodeScreen(), eventFromVerifyResponse(500, null))
    expect(s.phase).toBe("code")
    expect(s.message).toBe("Something went wrong. Please try again.")
  })

  it("a network error keeps the state and sets the generic message", () => {
    const s = run(onCodeScreen(), { type: "network_error" })
    expect(s.phase).toBe("code")
    expect(s.message).toBe("Something went wrong. Please try again.")
  })

  it("stays busy in signedIn so no form can be resubmitted while setSession runs", () => {
    const s = run(onCodeScreen(), eventFromVerifyResponse(200, { session: { access_token: "a", refresh_token: "b" } }))
    expect(s.phase).toBe("signedIn")
    expect(s.busy).toBe(true)
    expect(run(s, { type: "submitting", reqId: s.reqId + 1 })).toBe(s)
  })

  it("a setSession failure returns to the form with the generic message", () => {
    const signedIn = run(onCodeScreen(), eventFromVerifyResponse(200, { session: { access_token: "a", refresh_token: "b" } }))
    const s = run(signedIn, { type: "session_failed" })
    expect(s.phase).toBe("form")
    expect(s.busy).toBe(false)
    expect(s.session).toBeNull()
    expect(s.password).toBe("")
    expect(s.message).toBe("Something went wrong. Please try again.")
  })

  it("a stale response after 'Use a different number' leaves state unchanged", () => {
    let s = onCodeScreen()
    s = run(s, { type: "submitting", reqId: s.reqId + 1 })
    const inflight = s.reqId
    s = run(s, { type: "back" })
    expect(run(s, { type: "response", reqId: inflight, event: eventFromVerifyResponse(410, { error: "x" }) })).toBe(s)
    expect(run(s, { type: "response", reqId: inflight, event: { type: "challenge", id: "old", maskedPhone: "x" } })).toBe(s)
  })

  it("a stale challenge does not replace a newer one", () => {
    let s = run(initialPanelState(), { type: "submitting", reqId: 1 })
    s = run(s, { type: "response", reqId: 1, event: { type: "challenge", id: "first", maskedPhone: "a" } })
    s = run(s, { type: "back" })
    s = run(s, { type: "submitting", reqId: s.reqId + 1 })
    s = run(s, { type: "response", reqId: s.reqId, event: { type: "challenge", id: "second", maskedPhone: "b" } })
    const late = run(s, { type: "response", reqId: 1, event: { type: "challenge", id: "first", maskedPhone: "a" } })
    expect(late.challenge?.id).toBe("second")
  })

  it("a submit while busy is a no-op", () => {
    const s = run(initialPanelState(), { type: "submitting", reqId: 1 })
    expect(run(s, { type: "submitting", reqId: 2 })).toBe(s)
  })

  it("the current response is applied", () => {
    const s = run(initialPanelState(), { type: "submitting", reqId: 1 })
    expect(run(s, { type: "response", reqId: 1, event: { type: "challenge", id: "c", maskedPhone: "m" } }).phase).toBe("code")
  })

  it("code input keeps digits only, max 6", () => {
    const s = run(onCodeScreen(), { type: "edit", field: "code", value: "12a3-456789" })
    expect(s.code).toBe("123456")
  })
})
