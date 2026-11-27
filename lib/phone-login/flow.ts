/**
 * Orchestrators for phone-number login: step 1 (phone + password), verify (SMS code on an
 * unrecognised device) and resend. This is the security core, so the rules are:
 *  - every step-1 failure is the same `fail` and costs one password check (real or dummy);
 *  - a session is only returned (a) straight after a correct password on a trusted device /
 *    with the new-device code switched off, or (b) after a code check AND an atomic challenge
 *    consume; verify mints only for the email of the user the challenge row belongs to;
 *  - alerts and events carry hashes and ids only, never a phone, code, password or email.
 * DB errors from findAccount / beginAttempt / endAttempt / recordFailure, and auth-service errors from
 * verifyPassword (anything but a real wrong password), propagate (the route answers 503) and never count as a failure.
 */

import { randomUUID } from "node:crypto"
import type { SupabaseClient } from "@supabase/supabase-js"
import { normalizeGhanaPhone } from "@/lib/phone-format"
import { checkPhoneOtp, defaultPhoneOtpCode, issuePhoneOtp, type PhoneOtpDeps } from "@/lib/phone-otp"
import type { raiseSecurityAlert } from "@/lib/security-alerts"
import {
  LIMITS,
  PHONE_LOGIN_PURPOSE,
  isEligible,
  ipHash as hashIp,
  maskPhone,
  newToken,
  phoneHash as hashPhone,
  phoneKey,
  sha256Hex,
  uaLabel,
} from "./core"
import type { PhoneLoginSettings } from "./settings"
import {
  bumpChallengeAttempt,
  consumeChallenge,
  countDistinctPhonesFromIp,
  countEvents,
  createChallenge,
  findAccount,
  findTrustedDevice,
  getChallenge,
  hadPasswordChangeSince,
  beginAttempt,
  endAttempt,
  killChallenge,
  recordEvent,
  recordFailure,
  touchChallengeSent,
  touchDevice,
  trustDevice,
  type ChallengeRow,
} from "./store"
import { dummyPasswordCheck, mintSession, revokeSessionLocal, verifyPassword, type Session, type SessionDeps } from "./session"

export interface FlowDeps {
  db: SupabaseClient
  session: SessionDeps
  settings: () => Promise<PhoneLoginSettings>
  sendCode: (phone: string, code: string) => Promise<unknown>
  alert: typeof raiseSecurityAlert
  now: () => Date
  /** Email of the auth user (routes wire auth.admin.getUserById). Null when unknown. */
  emailForUser: (userId: string) => Promise<string | null>
}

export type StartResult =
  | { kind: "fail" }
  | { kind: "disabled" }
  | { kind: "session"; session: Session }
  | { kind: "challenge"; challengeId: string; browserSecret: string; maskedPhone: string }
  | { kind: "send_failed" }

const WINDOW_15_MIN = 900_000
const HOUR_MS = 3_600_000

/** sendSMS reports a delivery failure as `{ success: false }` instead of throwing. */
function smsFailed(sms: unknown): boolean {
  return typeof sms === "object" && sms !== null && (sms as { success?: unknown }).success === false
}

function otpDeps(d: FlowDeps): PhoneOtpDeps {
  return {
    db: d.db,
    sendCode: d.sendCode,
    now: () => d.now().getTime(),
    randomCode: defaultPhoneOtpCode,
  }
}

async function failAfterRecord(d: FlowDeps, pHash: string, iHash: string): Promise<void> {
  await recordFailure(d.db, pHash, iHash)
  // Alerting is best-effort and must never change the (generic) response.
  try {
    if ((await countDistinctPhonesFromIp(d.db, iHash, WINDOW_15_MIN)) > 20) {
      await d.alert({
        severity: "high",
        category: "phone_login_stuffing",
        title: "Phone login: many different numbers tried from one IP",
        detail: { ipHash: iHash },
        dedupeKey: iHash,
        dedupeWindowMin: 60,
      })
    }
    if ((await countEvents(d.db, "lockout", WINDOW_15_MIN)) > 10) {
      await d.alert({
        severity: "high",
        category: "phone_login_lockouts",
        title: "Phone login: unusual number of lockouts",
        detail: {},
        dedupeKey: "sitewide",
        dedupeWindowMin: 60,
      })
    }
  } catch {
    /* swallow */
  }
}

export async function startPhoneLogin(
  d: FlowDeps,
  i: { phone: string; password: string; ip: string; deviceToken: string | null },
): Promise<StartResult> {
  const settings = await d.settings()
  if (!settings.enabled) return { kind: "disabled" }

  const key = phoneKey(i.phone)
  if (!key) {
    await dummyPasswordCheck(d.session)
    return { kind: "fail" }
  }
  const pHash = hashPhone(key.sig)
  const iHash = hashIp(i.ip)

  // Atomic reserve-a-slot (per-phone lock in the RPC): parallel requests cannot all pass a stale "not locked" read.
  if (!(await beginAttempt(d.db, pHash, iHash))) {
    await dummyPasswordCheck(d.session)
    return { kind: "fail" }
  }

  const account = await findAccount(d.db, key.sig)
  if (!isEligible(account)) {
    await dummyPasswordCheck(d.session)
    await failAfterRecord(d, pHash, iHash)
    return { kind: "fail" }
  }

  // verifyPassword returns null only for a real wrong password; any auth-service error THROWS (no failure is recorded).
  const session = await verifyPassword(d.session, account.email, i.password)
  if (!session) {
    await failAfterRecord(d, pHash, iHash)
    return { kind: "fail" }
  }
  // Correct password: free the slot now, whatever happens next (recordFailure frees it on the wrong-password path).
  await endAttempt(d.db, pHash)

  if (i.deviceToken) {
    const dev = await findTrustedDevice(d.db, sha256Hex(i.deviceToken), account.userId, d.now())
    if (dev) {
      await touchDevice(d.db, dev.id, d.now())
      await recordEvent(d.db, "login_ok", { userId: account.userId, phoneHash: pHash, ipHash: iHash })
      return { kind: "session", session }
    }
  }

  if (!settings.newDeviceCode) {
    // Labelled apart from login_ok so admins can see logins that skipped the code check.
    await recordEvent(d.db, "login_unchallenged", { userId: account.userId, phoneHash: pHash, ipHash: iHash })
    return { kind: "session", session }
  }

  // Unrecognised device: the password session must never leave this function.
  await revokeSessionLocal(d.session, session.access_token)

  const otpPhone = normalizeGhanaPhone(account.phone)
  if (!otpPhone) return { kind: "send_failed" }

  const challengeId = randomUUID()
  const browserSecret = newToken()
  await createChallenge(d.db, {
    id: challengeId,
    userId: account.userId,
    browserSecretHash: sha256Hex(browserSecret),
    otpPhone,
    now: d.now(),
  })

  let sentOk = false
  try {
    const r = await issuePhoneOtp(otpDeps(d), otpPhone, PHONE_LOGIN_PURPOSE)
    sentOk = r.ok && !smsFailed(r.sms)
  } catch {
    sentOk = false
  }
  if (!sentOk) {
    await killChallenge(d.db, challengeId)
    return { kind: "send_failed" }
  }

  await recordEvent(d.db, "challenge_sent", { userId: account.userId, phoneHash: pHash, ipHash: iHash })
  return { kind: "challenge", challengeId, browserSecret, maskedPhone: maskPhone(otpPhone) }
}

/** Missing, expired, consumed, or wrong browser secret -> null (caller restarts). */
async function liveChallenge(
  d: FlowDeps,
  challengeId: string,
  browserSecret: string | null,
): Promise<ChallengeRow | null> {
  if (!browserSecret) return null
  const c = await getChallenge(d.db, challengeId)
  if (!c) return null
  if (c.consumedAt || c.expiresAt.getTime() <= d.now().getTime()) return null
  if (sha256Hex(browserSecret) !== c.browserSecretHash) return null
  return c
}

export type VerifyResult =
  | { kind: "session"; session: Session; deviceToken: string }
  | { kind: "invalid"; attemptsLeft: number }
  | { kind: "restart" }

export async function verifyPhoneLogin(
  d: FlowDeps,
  i: { challengeId: string; browserSecret: string | null; code: string; ip: string; userAgent: string | null },
): Promise<VerifyResult> {
  // The kill switch must also stop sign-ins already in flight.
  if (!(await d.settings()).enabled) return { kind: "restart" }
  const c = await liveChallenge(d, i.challengeId, i.browserSecret)
  if (!c) return { kind: "restart" }
  const max = LIMITS.maxCodeAttempts
  if (c.attempts >= max) return { kind: "restart" }

  const result = await checkPhoneOtp(
    { db: d.db, now: () => d.now().getTime() },
    c.otpPhone,
    i.code,
    PHONE_LOGIN_PURPOSE,
  )
  if (result === "too_many_attempts") {
    await killChallenge(d.db, c.id)
    return { kind: "restart" }
  }
  if (result === "unavailable") return { kind: "invalid", attemptsLeft: max - c.attempts }
  if (result !== "verified") {
    const attempts = await bumpChallengeAttempt(d.db, c.id)
    if (attempts >= max) {
      await killChallenge(d.db, c.id)
      return { kind: "restart" }
    }
    return { kind: "invalid", attemptsLeft: max - attempts }
  }

  // A lookup that THROWS propagates before the challenge is consumed. A null email is final: checkPhoneOtp has
  // already marked the code used, so the challenge is killed rather than left half-alive.
  const email = await d.emailForUser(c.userId)
  if (!email) {
    await killChallenge(d.db, c.id)
    return { kind: "restart" }
  }

  if (!(await consumeChallenge(d.db, c.id, d.now()))) return { kind: "restart" }

  const iHash = hashIp(i.ip)
  const session = await mintSession(d.session, email)
  const deviceToken = newToken()
  await trustDevice(d.db, {
    userId: c.userId,
    tokenHash: sha256Hex(deviceToken),
    uaLabel: uaLabel(i.userAgent),
    now: d.now(),
  })
  await recordEvent(d.db, "challenge_passed", { userId: c.userId, ipHash: iHash })

  try {
    if (await hadPasswordChangeSince(d.db, c.userId, d.now().getTime() - 24 * HOUR_MS)) {
      await d.alert({
        severity: "info",
        category: "phone_login_after_reset",
        title: "Phone login on a new device shortly after a password change",
        detail: { userId: c.userId, ipHash: iHash },
      })
    }
  } catch {
    /* swallow */
  }

  return { kind: "session", session, deviceToken }
}

export type ResendResult =
  | { kind: "sent" }
  | { kind: "wait"; seconds: number }
  | { kind: "restart" }
  | { kind: "send_failed" }

export async function resendPhoneLoginCode(
  d: FlowDeps,
  i: { challengeId: string; browserSecret: string | null },
): Promise<ResendResult> {
  if (!(await d.settings()).enabled) return { kind: "restart" }
  const c = await liveChallenge(d, i.challengeId, i.browserSecret)
  if (!c) return { kind: "restart" }

  const elapsed = d.now().getTime() - c.lastSentAt.getTime()
  if (elapsed < LIMITS.resendGapMs) {
    return { kind: "wait", seconds: Math.ceil((LIMITS.resendGapMs - elapsed) / 1000) }
  }

  let r: Awaited<ReturnType<typeof issuePhoneOtp>>
  try {
    r = await issuePhoneOtp(otpDeps(d), c.otpPhone, PHONE_LOGIN_PURPOSE)
  } catch {
    await killChallenge(d.db, c.id)
    return { kind: "send_failed" }
  }
  if (!r.ok) {
    if (r.reason === "PHONE_LIMIT") return { kind: "wait", seconds: 3600 }
    await killChallenge(d.db, c.id)
    return { kind: "send_failed" }
  }
  if (smsFailed(r.sms)) {
    await killChallenge(d.db, c.id)
    return { kind: "send_failed" }
  }
  await touchChallengeSent(d.db, c.id, d.now())
  return { kind: "sent" }
}
