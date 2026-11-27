import { NextRequest } from "next/server"
import { verifyPhoneLogin } from "@/lib/phone-login/flow"
import { hashSecretConfigured } from "@/lib/phone-login/core"
import { getClientIdentifier } from "@/lib/rate-limiter"
import { buildFlowDeps } from "../deps"
import {
  CHALLENGE_COOKIE,
  clearChallengeCookie,
  ipAllowed,
  json,
  logFlowError,
  readBody,
  setDeviceCookie,
  tooMany,
  unavailable,
} from "../http"

const RESTART_MSG = "This sign-in has expired. Please start again."

export async function POST(request: NextRequest) {
  if (!hashSecretConfigured()) return unavailable()
  if (!(await ipAllowed(request, "phone_login_verify"))) return tooMany()

  const body = await readBody(request)
  const challengeId = body?.challengeId
  const code = body?.code
  if (typeof challengeId !== "string" || challengeId.length === 0 || challengeId.length > 64) {
    return json({ error: RESTART_MSG }, 410)
  }
  if (typeof code !== "string" || !/^\d{6}$/.test(code)) {
    return json({ error: "That code is not right.", attemptsLeft: null }, 400)
  }

  try {
    const r = await verifyPhoneLogin(buildFlowDeps(), {
      challengeId,
      browserSecret: request.cookies.get(CHALLENGE_COOKIE)?.value ?? null,
      code,
      ip: getClientIdentifier(request),
      userAgent: request.headers.get("user-agent"),
    })
    if (r.kind === "session") {
      const res = json({ session: r.session })
      setDeviceCookie(res, r.deviceToken)
      clearChallengeCookie(res)
      return res
    }
    if (r.kind === "invalid") {
      return json({ error: "That code is not right.", attemptsLeft: r.attemptsLeft }, 400)
    }
    const res = json({ error: RESTART_MSG }, 410)
    clearChallengeCookie(res)
    return res
  } catch {
    logFlowError()
    return unavailable()
  }
}
