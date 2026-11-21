import { describe, it, expect, vi, afterEach } from "vitest"
import { isSuspended, suspensionStatus } from "@/lib/auth/suspension"

const fakeDb = (result: { data: unknown; error: unknown } | "throw") =>
  ({
    from: (t: string) => {
      if (t !== "users") throw new Error("unexpected table")
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => {
              if (result === "throw") throw new Error("network")
              return result
            },
          }),
        }),
      }
    },
  }) as never

afterEach(() => vi.restoreAllMocks())

describe("isSuspended", () => {
  it("is_suspended_true", async () => {
    expect(await isSuspended(fakeDb({ data: { is_suspended: true }, error: null }), "u1")).toBe(true)
  })
  it("is false for an active user", async () => {
    expect(await isSuspended(fakeDb({ data: { is_suspended: false }, error: null }), "u1")).toBe(false)
    expect(await isSuspended(fakeDb({ data: { is_suspended: null }, error: null }), "u1")).toBe(false)
  })
  it("read_error_fails_closed (error, throw, missing row) with a PII-free marker", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    expect(await isSuspended(fakeDb({ data: null, error: { message: "boom u1" } }), "u1")).toBe(true)
    expect(await isSuspended(fakeDb("throw"), "u1")).toBe(true)
    expect(await isSuspended(fakeDb({ data: null, error: null }), "u1")).toBe(true)
    for (const c of err.mock.calls) expect(JSON.stringify(c)).not.toContain("u1")
    expect(err).toHaveBeenCalledWith("[AUTH] suspension_check_failed")
  })
})

describe("suspensionStatus (tri-state)", () => {
  it("active / suspended / unknown", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    expect(await suspensionStatus(fakeDb({ data: { is_suspended: false }, error: null }), "u1")).toBe("active")
    expect(await suspensionStatus(fakeDb({ data: { is_suspended: null }, error: null }), "u1")).toBe("active")
    expect(await suspensionStatus(fakeDb({ data: { is_suspended: true }, error: null }), "u1")).toBe("suspended")
    expect(await suspensionStatus(fakeDb({ data: null, error: null }), "u1")).toBe("suspended") // missing row
    expect(await suspensionStatus(fakeDb({ data: null, error: { message: "boom" } }), "u1")).toBe("unknown")
    expect(await suspensionStatus(fakeDb("throw"), "u1")).toBe("unknown")
  })
})
