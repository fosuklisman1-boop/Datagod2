import { describe, it, expect, beforeEach, vi, afterEach } from "vitest"
import { createFakeDb, type FakeQuery } from "@/lib/admin-users/test-fake-db"
import {
  createPasswordResetLink, passwordResetUrl, recentResetCount, RESET_MAX_PER_HOUR, RESET_TOKEN_TTL_MINUTES,
} from "./password-reset"

const NOW = new Date("2026-11-02T10:00:00.000Z")

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  process.env.NEXT_PUBLIC_APP_URL = "https://app.example"
})
afterEach(() => vi.useRealTimers())

describe("lib/password-reset", () => {
  it("the limits the emails and routes promise", () => {
    expect(RESET_TOKEN_TTL_MINUTES).toBe(5)
    expect(RESET_MAX_PER_HOUR).toBe(3)
  })

  it("builds the /auth/reset-password link the reset page consumes", () => {
    expect(passwordResetUrl("tok-1")).toBe("https://app.example/auth/reset-password?token=tok-1")
  })

  it("creates a token row that expires in 5 minutes and returns its link", async () => {
    const fake = createFakeDb({ tables: { password_reset_requests: () => ({ data: { id: "tok-9" }, error: null }) } })
    const link = await createPasswordResetLink(fake.db as any, { id: "u1", email: "a@x.com", phone_number: "0244" })
    expect(link).toEqual({ token: "tok-9", url: "https://app.example/auth/reset-password?token=tok-9" })
    const [q] = fake.queries
    expect(q.kind).toBe("insert")
    expect(q.payload).toEqual({ user_id: "u1", email: "a@x.com", phone_number: "0244", expires_at: "2026-11-02T10:05:00.000Z" })
  })

  it("returns null (not a link) when the insert fails", async () => {
    const fake = createFakeDb({ tables: { password_reset_requests: () => ({ data: null, error: { message: "down" } }) } })
    vi.spyOn(console, "error").mockImplementation(() => {})
    expect(await createPasswordResetLink(fake.db as any, { id: "u1", email: null, phone_number: null })).toBeNull()
  })

  it("counts this user's requests in the last hour; null when the count fails", async () => {
    let fake = createFakeDb({ tables: { password_reset_requests: () => ({ data: null, error: null, count: 2 }) } })
    expect(await recentResetCount(fake.db as any, "u1")).toBe(2)
    const q = fake.queries[0] as FakeQuery
    expect(q.head).toBe(true)
    expect(q.filter("user_id")).toBe("u1")
    expect(q.op("gte")).toEqual(["gte", "created_at", "2026-11-02T09:00:00.000Z"])
    fake = createFakeDb({ tables: { password_reset_requests: () => ({ data: null, error: { message: "x" } }) } })
    expect(await recentResetCount(fake.db as any, "u1")).toBeNull()
  })
})
