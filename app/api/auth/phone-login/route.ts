import { NextRequest } from "next/server"
import { startPhoneLogin } from "@/lib/phone-login/flow"
import { hashSecretConfigured } from "@/lib/phone-login/core"
import { getClientIdentifier } from "@/lib/rate-limiter"
import { buildFlowDeps } from "./deps"
import {
  DEVICE_COOKIE,
  STEP1_FLOOR_MS,
  STEP1_JITTER_MS,
  genericFail,
  ipAllowed,
  json,
  logFlowError,
  readBody,
  setChallengeCookie,
  timingNow,
  tooMany,
  unavailable,
  withTimingFloor,
} from "./http"

export async function GET() {
  try {
    // Fail closed: without the hash secret the feature is not usable, whatever the setting says.
    if (!hashSecretConfigured()) return json({ enabled: false })
    const s = await buildFlowDeps().settings()
    return json({ enabled: s.enabled })
  } catch {
    logFlowError()
    return unavailable()
  }
}

async function handle(request: NextRequest) {
  if (!hashSecretConfigured()) return unavailable()
  if (!(await ipAllowed(request, "phone_login"))) return tooMany()

  const body = await readBody(request)
  const phone = body?.phone
  const password = body?.password
  if (typeof phone !== "string" || typeof password !== "string" || phone.length > 20 || password.length > 200) {
    return genericFail()
  }

  try {
    const r = await startPhoneLogin(buildFlowDeps(), {
      phone,
      password,
      ip: getClientIdentifier(request),
      deviceToken: request.cookies.get(DEVICE_COOKIE)?.value ?? null,
    })
    switch (r.kind) {
      case "fail":
        return genericFail()
      case "disabled":
        return json({ error: "Phone sign-in is not available." }, 404)
      case "send_failed":
        return unavailable()
      case "session":
        return json({ session: r.session })
      case "challenge": {
        const res = json({ challenge: { id: r.challengeId, maskedPhone: r.maskedPhone } })
        setChallengeCookie(res, r.browserSecret)
        return res
      }
    }
  } catch {
    logFlowError()
    return unavailable()
  }
}

export async function POST(request: NextRequest) {
  const startMs = timingNow()
  const res = await handle(request)
  // Every outcome leaves no sooner than the floor, so a real bcrypt compare and the dummy check look the same.
  await withTimingFloor(startMs, STEP1_FLOOR_MS, STEP1_JITTER_MS)
  return res
}
