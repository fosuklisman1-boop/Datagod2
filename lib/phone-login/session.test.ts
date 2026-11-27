import { describe, it, expect, vi } from "vitest"
import {
  verifyPassword,
  dummyPasswordCheck,
  revokeSessionLocal,
  mintSession,
  type SessionDeps,
} from "./session"

const sess = { access_token: "at", refresh_token: "rt", expires_at: 123 }

function makeDeps(over: {
  signIn?: unknown
  verifyOtp?: unknown
  generateLink?: unknown
  signOut?: unknown
} = {}) {
  const signInWithPassword = vi.fn().mockResolvedValue(over.signIn ?? { data: { session: sess }, error: null })
  const verifyOtp = vi.fn().mockResolvedValue(over.verifyOtp ?? { data: { session: sess }, error: null })
  const generateLink = vi
    .fn()
    .mockResolvedValue(over.generateLink ?? { data: { properties: { hashed_token: "HASH" } }, error: null })
  const signOut = vi.fn().mockResolvedValue(over.signOut ?? { error: null })
  const inviteUserByEmail = vi.fn()
  const resetPasswordForEmail = vi.fn()
  const signInWithOtp = vi.fn()
  const deps = {
    anon: () => ({ auth: { signInWithPassword, verifyOtp, resetPasswordForEmail, signInWithOtp } }),
    admin: { auth: { admin: { generateLink, signOut, inviteUserByEmail } } },
  } as unknown as SessionDeps
  return { deps, signInWithPassword, verifyOtp, generateLink, signOut, inviteUserByEmail, resetPasswordForEmail, signInWithOtp }
}

describe("revokeSessionLocal", () => {
  it("calls signOut with exactly (token, 'local')", async () => {
    const m = makeDeps()
    await revokeSessionLocal(m.deps, "tok")
    expect(m.signOut).toHaveBeenCalledTimes(1)
    expect(m.signOut.mock.calls[0]).toEqual(["tok", "local"])
  })
  it("throws on error", async () => {
    const m = makeDeps({ signOut: { error: new Error("x") } })
    await expect(revokeSessionLocal(m.deps, "tok")).rejects.toThrow()
  })
})

describe("verifyPassword", () => {
  it("returns the session on success", async () => {
    const m = makeDeps()
    expect(await verifyPassword(m.deps, "a@b.c", "pw")).toEqual(sess)
    expect(m.signInWithPassword).toHaveBeenCalledWith({ email: "a@b.c", password: "pw" })
  })
  it("returns null on invalid_credentials (a real wrong password)", async () => {
    const m = makeDeps({ signIn: { data: { session: null }, error: Object.assign(new Error("Invalid login credentials"), { code: "invalid_credentials", status: 400 }) } })
    expect(await verifyPassword(m.deps, "a@b.c", "pw")).toBeNull()
  })
  it("returns null on email_not_confirmed and on the legacy invalid-login message without a code", async () => {
    const m1 = makeDeps({ signIn: { data: { session: null }, error: Object.assign(new Error("Email not confirmed"), { code: "email_not_confirmed", status: 400 }) } })
    expect(await verifyPassword(m1.deps, "a@b.c", "pw")).toBeNull()
    const m2 = makeDeps({ signIn: { data: { session: null }, error: Object.assign(new Error("Invalid login credentials"), { status: 400 }) } })
    expect(await verifyPassword(m2.deps, "a@b.c", "pw")).toBeNull()
  })
  it("THROWS on rate limit, server error and captcha so the caller never counts them as a wrong password", async () => {
    for (const [code, status] of [["over_request_rate_limit", 429], ["unexpected_failure", 500], ["captcha_failed", 400], [undefined, 503]] as const) {
      const m = makeDeps({ signIn: { data: { session: null }, error: Object.assign(new Error("boom"), { code, status }) } })
      await expect(verifyPassword(m.deps, "a@b.c", "pw")).rejects.toThrow()
    }
  })
  it("THROWS when the client throws (network)", async () => {
    const m = makeDeps()
    m.signInWithPassword.mockRejectedValue(new Error("net"))
    await expect(verifyPassword(m.deps, "a@b.c", "pw")).rejects.toThrow()
  })
  it("THROWS when there is neither a session nor an error", async () => {
    const m = makeDeps({ signIn: { data: { session: null }, error: null } })
    await expect(verifyPassword(m.deps, "a@b.c", "pw")).rejects.toThrow()
  })
})

describe("dummyPasswordCheck", () => {
  it("calls signInWithPassword against a non-existent address and swallows errors", async () => {
    const m = makeDeps()
    m.signInWithPassword.mockRejectedValue(new Error("net"))
    await expect(dummyPasswordCheck(m.deps)).resolves.toBeUndefined()
    const arg = m.signInWithPassword.mock.calls[0][0]
    expect(arg.email).toBe("no-such-user@invalid.datagod")
    expect(typeof arg.password).toBe("string")
    expect(arg.password.length).toBeGreaterThan(8)
  })
})

describe("mintSession", () => {
  it("passes hashed_token through and sends no email", async () => {
    const m = makeDeps()
    expect(await mintSession(m.deps, "a@b.c")).toEqual(sess)
    expect(m.generateLink).toHaveBeenCalledWith({ type: "magiclink", email: "a@b.c" })
    expect(m.verifyOtp).toHaveBeenCalledWith({ type: "magiclink", token_hash: "HASH" })
    expect(m.inviteUserByEmail).not.toHaveBeenCalled()
    expect(m.resetPasswordForEmail).not.toHaveBeenCalled()
    expect(m.signInWithOtp).not.toHaveBeenCalled()
  })
  it("throws if verifyOtp returns no session", async () => {
    const m = makeDeps({ verifyOtp: { data: { session: null }, error: null } })
    await expect(mintSession(m.deps, "a@b.c")).rejects.toThrow()
  })
  it("throws if generateLink errors or has no token", async () => {
    const m1 = makeDeps({ generateLink: { data: null, error: new Error("x") } })
    await expect(mintSession(m1.deps, "a@b.c")).rejects.toThrow()
    const m2 = makeDeps({ generateLink: { data: { properties: {} }, error: null } })
    await expect(mintSession(m2.deps, "a@b.c")).rejects.toThrow()
  })
})
