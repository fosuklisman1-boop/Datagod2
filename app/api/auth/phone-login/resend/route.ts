import { NextRequest } from "next/server"
import { resendPhoneLoginCode } from "@/lib/phone-login/flow"
import { buildFlowDeps } from "../deps"
import {
  CHALLENGE_COOKIE,
  clearChallengeCookie,
  ipAllowed,
  json,
  logFlowError,
  readBody,
  tooMany,
  unavailable,
} from "../http"

const RESTART_MSG = "This sign-in has expired. Please start again."

export async function POST(request: NextRequest) {
  // Resend shares the verify bucket: it triggers SMS, so it must be IP-limited too.
  if (!(await ipAllowed(request, "phone_login_verify"))) return tooMany()

  const body = await readBody(request)
  const challengeId = body?.challengeId
  if (typeof challengeId !== "string" || challengeId.length === 0 || challengeId.length > 64) {
    return json({ error: RESTART_MSG }, 410)
  }

  try {
    const r = await resendPhoneLoginCode(buildFlowDeps(), {
      challengeId,
      browserSecret: request.cookies.get(CHALLENGE_COOKIE)?.value ?? null,
    })
    switch (r.kind) {
      case "sent":
        return json({ sent: true })
      case "wait":
        return json({ error: "Please wait before requesting another code.", seconds: r.seconds }, 429)
      case "send_failed":
        return unavailable()
      case "restart": {
        const res = json({ error: RESTART_MSG }, 410)
        clearChallengeCookie(res)
        return res
      }
    }
  } catch {
    logFlowError()
    return unavailable()
  }
}
