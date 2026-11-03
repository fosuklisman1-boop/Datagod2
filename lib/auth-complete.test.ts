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

import { resolvePostAuthRedirect } from "./auth-complete"

const fetchSpy = vi.fn(async () => ({ ok: true, status: 201 }))

const opts = {
  origin: "https://datagod.store",
  userId: "new-user",
  email: "ama@example.com",
  // Even if the user edits metadata to look like a normal signup, a join intent wins.
  userMetadata: { first_name: "Ama", phone_number: "0241234567" },
  accessToken: "tok",
  next: "/dashboard",
}

beforeEach(() => {
  finalizeJoinIntent.mockReset()
  fetchSpy.mockClear()
  vi.stubGlobal("fetch", fetchSpy)
})
afterEach(() => vi.unstubAllGlobals())

describe("resolvePostAuthRedirect with join intents", () => {
  it("a join intent's target wins and the OTP-requiring signup path is never called", async () => {
    finalizeJoinIntent.mockResolvedValue({ target: "/dashboard/shop-pricing?setup=1" })
    expect(await resolvePostAuthRedirect(opts)).toBe("/dashboard/shop-pricing?setup=1")
    expect(finalizeJoinIntent).toHaveBeenCalledWith(expect.anything(), "new-user", { email: "ama@example.com" })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("a closed target is returned as is", async () => {
    finalizeJoinIntent.mockResolvedValue({ target: "/dashboard?join=closed" })
    expect(await resolvePostAuthRedirect(opts)).toBe("/dashboard?join=closed")
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("no intent: the normal signup finalize runs", async () => {
    finalizeJoinIntent.mockResolvedValue(null)
    expect(await resolvePostAuthRedirect(opts)).toBe("/dashboard")
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it("a failed join finalize does not fall through to the signup path", async () => {
    finalizeJoinIntent.mockRejectedValue(Object.assign(new Error("boom"), { code: "XX000" }))
    expect(await resolvePostAuthRedirect(opts)).toBe("/dashboard?join=error")
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
