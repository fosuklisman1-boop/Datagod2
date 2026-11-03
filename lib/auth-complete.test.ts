import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

const finalizeJoinIntent = vi.fn()
const profileLookup = vi.fn(async () => ({ data: null, error: null }))

vi.mock("@/lib/sub-agents/join", () => ({
  finalizeJoinIntent: (...a: unknown[]) => finalizeJoinIntent(...a),
}))
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: profileLookup }) }) }),
  }),
}))

import { resolvePostAuthRedirect, joinConfirmationFrom } from "./auth-complete"

const fetchSpy = vi.fn(async () => ({ ok: true, status: 201 }))

const base = {
  origin: "https://datagod.store",
  userId: "new-user",
  email: "ama@example.com",
  // Even if the user edits metadata to look like a normal signup, a join intent wins.
  userMetadata: { first_name: "Ama", phone_number: "0241234567" },
  accessToken: "tok",
  next: "/dashboard",
}
/** What /auth/confirm passes for a signup confirmation carrying a join nonce. */
const confirm = { ...base, joinConfirmation: { nonce: "n1", identities: ["email"] } }

beforeEach(() => {
  finalizeJoinIntent.mockReset()
  fetchSpy.mockClear()
  vi.stubGlobal("fetch", fetchSpy)
})
afterEach(() => vi.unstubAllGlobals())

describe("resolvePostAuthRedirect with join intents", () => {
  it("a join intent's target wins and the OTP-requiring signup path is never called", async () => {
    finalizeJoinIntent.mockResolvedValue({ target: "/dashboard/shop-pricing?setup=1" })
    expect(await resolvePostAuthRedirect(confirm)).toBe("/dashboard/shop-pricing?setup=1")
    expect(finalizeJoinIntent).toHaveBeenCalledWith(expect.anything(), "new-user", {
      email: "ama@example.com",
      nonce: "n1",
      identities: ["email"],
    })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("a closed target is returned as is", async () => {
    finalizeJoinIntent.mockResolvedValue({ target: "/dashboard?join=closed" })
    expect(await resolvePostAuthRedirect(confirm)).toBe("/dashboard?join=closed")
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("no intent: the normal signup finalize runs", async () => {
    finalizeJoinIntent.mockResolvedValue(null)
    expect(await resolvePostAuthRedirect(confirm)).toBe("/dashboard")
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it("a failed join finalize does not fall through to the signup path", async () => {
    finalizeJoinIntent.mockRejectedValue(Object.assign(new Error("boom"), { code: "XX000" }))
    expect(await resolvePostAuthRedirect(confirm)).toBe("/dashboard?join=error")
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("without a join confirmation (OAuth callback, magic link) the join is never finalized", async () => {
    finalizeJoinIntent.mockResolvedValue({ target: "/dashboard/shop-pricing?setup=1" })
    expect(await resolvePostAuthRedirect(base)).toBe("/dashboard")
    expect(finalizeJoinIntent).not.toHaveBeenCalled()
  })
})

describe("joinConfirmationFrom", () => {
  const user = { identities: [{ provider: "email" }] }
  const q = (s: string) => new URLSearchParams(s)

  it("only for signup confirmations (type signup or email)", () => {
    expect(joinConfirmationFrom("signup", q("join=abc"), user)).toEqual({ nonce: "abc", identities: ["email"] })
    expect(joinConfirmationFrom("email", q("join=abc"), user)).toEqual({ nonce: "abc", identities: ["email"] })
    expect(joinConfirmationFrom("magiclink", q("join=abc"), user)).toBeNull()
    expect(joinConfirmationFrom("email_change", q("join=abc"), user)).toBeNull()
    expect(joinConfirmationFrom("invite", q("join=abc"), user)).toBeNull()
  })

  it("reads the nonce from the redirect URL carried in rt or next", () => {
    const rt = encodeURIComponent("https://datagod.store/auth/callback?join=xyz")
    expect(joinConfirmationFrom("email", q(`next=/dashboard&rt=${rt}`), user)?.nonce).toBe("xyz")
    // Unencoded, as GoTrue substitutes {{ .RedirectTo }} into the template.
    expect(joinConfirmationFrom("email", q("next=/dashboard&rt=https://datagod.store/auth/callback?join=xyz"), user)?.nonce).toBe("xyz")
    expect(joinConfirmationFrom("signup", q(`next=${rt}`), user)?.nonce).toBe("xyz")
  })

  it("no nonce anywhere: null nonce (finalize then refuses)", () => {
    expect(joinConfirmationFrom("email", q("next=/dashboard"), user)).toEqual({ nonce: null, identities: ["email"] })
  })

  it("passes every identity provider through", () => {
    expect(joinConfirmationFrom("email", q("join=a"), { identities: [{ provider: "email" }, { provider: "google" }] })?.identities).toEqual([
      "email",
      "google",
    ])
    expect(joinConfirmationFrom("email", q("join=a"), {})?.identities).toBeUndefined()
  })
})
