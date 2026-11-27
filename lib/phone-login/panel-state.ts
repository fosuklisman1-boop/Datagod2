// Pure state machine for the login page's phone tab. No React, no fetch:
// the component dispatches events and renders the state.

export const GENERIC_ERROR = "Something went wrong. Please try again."
export const RESEND_COOLDOWN_SECONDS = 60

export type PanelState = {
  /** Phone tab shown (GET said enabled). */
  visible: boolean
  phase: "form" | "code" | "signedIn"
  phone: string
  password: string
  code: string
  challenge: { id: string; maskedPhone: string } | null
  attemptsLeft: number | null
  resendSeconds: number
  /** Latest user-facing message; `noticeId` bumps on every new one so the component can toast it. */
  message: string | null
  noticeId: number
  /** Step 1 unavailable: send the user to the Email tab. */
  focusEmail: boolean
  session: unknown | null
  busy: boolean
  /** Id of the request currently allowed to apply its response. */
  reqId: number
}

export type PanelEvent =
  | { type: "availability"; enabled: boolean | null }
  | { type: "edit"; field: "phone" | "password" | "code"; value: string }
  | { type: "submitting"; reqId: number }
  /** A network response tagged with the request that produced it; dropped unless it is the current one. */
  | { type: "response"; reqId: number; event: PanelEvent }
  | { type: "session_failed" }
  | { type: "challenge"; id: string; maskedPhone: string }
  | { type: "session"; session: unknown }
  | { type: "failed"; message: string }
  | { type: "unavailable"; message: string }
  | { type: "restart"; message: string }
  | { type: "invalid_code"; message: string; attemptsLeft: number | null }
  | { type: "resent" }
  | { type: "resend_wait"; seconds: number }
  | { type: "tick" }
  | { type: "back" }
  | { type: "network_error" }

export function initialPanelState(): PanelState {
  return {
    visible: false,
    phase: "form",
    phone: "",
    password: "",
    code: "",
    challenge: null,
    attemptsLeft: null,
    resendSeconds: 0,
    message: null,
    noticeId: 0,
    focusEmail: false,
    session: null,
    busy: false,
    reqId: 0,
  }
}

function notice(s: PanelState, message: string): PanelState {
  return { ...s, message, noticeId: s.noticeId + 1 }
}

export function panelReducer(s: PanelState, e: PanelEvent): PanelState {
  switch (e.type) {
    case "availability":
      return { ...s, visible: e.enabled === true }
    case "edit": {
      if (e.field === "code") return { ...s, code: e.value.replace(/\D/g, "").slice(0, 6) }
      return { ...s, [e.field]: e.value }
    }
    case "submitting":
      if (s.busy) return s
      return { ...s, busy: true, focusEmail: false, reqId: e.reqId }
    case "response":
      return e.reqId === s.reqId ? panelReducer(s, e.event) : s
    case "session_failed":
      return notice(
        { ...s, busy: false, phase: "form", session: null, password: "", code: "", challenge: null, reqId: s.reqId + 1 },
        GENERIC_ERROR,
      )
    case "challenge":
      return {
        ...s,
        busy: false,
        phase: "code",
        challenge: { id: e.id, maskedPhone: e.maskedPhone },
        code: "",
        attemptsLeft: null,
        resendSeconds: RESEND_COOLDOWN_SECONDS,
        message: null,
      }
    case "session":
      // Stay busy: the component is installing the session and navigating.
      return { ...s, busy: true, phase: "signedIn", session: e.session, password: "", code: "" }
    case "failed":
      return notice({ ...s, busy: false }, e.message)
    case "unavailable":
      return notice({ ...s, busy: false, focusEmail: true }, e.message)
    case "restart":
      return notice(
        { ...s, busy: false, phase: "form", password: "", code: "", challenge: null, attemptsLeft: null, resendSeconds: 0 },
        e.message,
      )
    case "invalid_code":
      return notice({ ...s, busy: false, code: "", attemptsLeft: e.attemptsLeft }, e.message)
    case "resent":
      return { ...s, busy: false, resendSeconds: RESEND_COOLDOWN_SECONDS }
    case "resend_wait":
      return { ...s, busy: false, resendSeconds: Math.max(0, Math.ceil(e.seconds)) }
    case "tick":
      return s.resendSeconds > 0 ? { ...s, resendSeconds: s.resendSeconds - 1 } : s
    case "back":
      return {
        ...s,
        phase: "form",
        password: "",
        code: "",
        challenge: null,
        attemptsLeft: null,
        resendSeconds: 0,
        busy: false,
        reqId: s.reqId + 1,
      }
    case "network_error":
      return notice({ ...s, busy: false }, GENERIC_ERROR)
  }
}

// ---- response mappers -------------------------------------------------

function obj(body: unknown): Record<string, unknown> {
  return body && typeof body === "object" ? (body as Record<string, unknown>) : {}
}

function errorText(body: unknown): string {
  const m = obj(body).error
  return typeof m === "string" && m.length > 0 ? m : GENERIC_ERROR
}

export function eventFromStartResponse(status: number, body: unknown): PanelEvent {
  const b = obj(body)
  if (status === 200) {
    if (b.session) return { type: "session", session: b.session }
    const c = obj(b.challenge)
    if (typeof c.id === "string" && typeof c.maskedPhone === "string") {
      return { type: "challenge", id: c.id, maskedPhone: c.maskedPhone }
    }
    return { type: "failed", message: GENERIC_ERROR }
  }
  if (status === 503) return { type: "unavailable", message: errorText(body) }
  if (status === 401 || status === 404 || status === 429) return { type: "failed", message: errorText(body) }
  return { type: "failed", message: GENERIC_ERROR }
}

export function eventFromVerifyResponse(status: number, body: unknown): PanelEvent {
  const b = obj(body)
  if (status === 200 && b.session) return { type: "session", session: b.session }
  if (status === 400) {
    return {
      type: "invalid_code",
      message: errorText(body),
      attemptsLeft: typeof b.attemptsLeft === "number" ? b.attemptsLeft : null,
    }
  }
  if (status === 410) return { type: "restart", message: errorText(body) }
  if (status === 429 || status === 503) return { type: "failed", message: errorText(body) }
  return { type: "failed", message: GENERIC_ERROR }
}

export function eventFromResendResponse(status: number, body: unknown): PanelEvent {
  const b = obj(body)
  if (status === 200) return { type: "resent" }
  if (status === 429 && typeof b.seconds === "number") return { type: "resend_wait", seconds: b.seconds }
  if (status === 410) return { type: "restart", message: errorText(body) }
  if (status === 429 || status === 503) return { type: "failed", message: errorText(body) }
  return { type: "failed", message: GENERIC_ERROR }
}
