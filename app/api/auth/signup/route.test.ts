import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { NextRequest } from "next/server"

// ---------------------------------------------------------------------------
// Fake service-role Supabase client. Every query builder is chainable and
// thenable; the result comes from `resultFor(call)`. Every call is recorded.
// ---------------------------------------------------------------------------
type Call = { table: string; op: string; chain: Array<[string, unknown[]]>; payload?: unknown }
const calls: Call[] = []
let updateResult: () => Promise<{ error: unknown }> = async () => ({ error: null })
let userMetadata: Record<string, unknown> = {}

const USER_ID = "11111111-2222-3333-4444-555555555555"
const EMAIL = "kofi.mensah@example.com"
const PHONE = "0241234567"

function resultFor(call: Call): Promise<unknown> {
  if (call.table === "app_settings") return Promise.resolve({ data: { signups_enabled: true, signup_default_role: "user" }, error: null })
  if (call.table === "phone_otp_verifications") return Promise.resolve({ data: { id: 1 }, error: null })
  if (call.table === "users" && call.op === "select") return Promise.resolve({ data: null, error: null })
  if (call.table === "users" && call.op === "upsert") return Promise.resolve({ data: [{ id: USER_ID }], error: null })
  if (call.table === "users" && call.op === "update") return updateResult()
  return Promise.resolve({ data: null, error: null })
}

function builder(table: string) {
  const call: Call = { table, op: "select", chain: [] }
  const b: any = {}
  for (const m of ["select", "eq", "is", "gte", "order", "limit"]) {
    b[m] = (...args: unknown[]) => {
      call.chain.push([m, args])
      return b
    }
  }
  for (const op of ["upsert", "update", "insert"]) {
    b[op] = (payload: unknown, ...rest: unknown[]) => {
      call.op = op
      call.payload = payload
      call.chain.push([op, [payload, ...rest]])
      return b
    }
  }
  b.single = () => resultFor(call)
  b.maybeSingle = () => resultFor(call)
  b.then = (ok: any, bad: any) => resultFor(call).then(ok, bad)
  calls.push(call)
  return b
}

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: (table: string) => builder(table),
    auth: {
      getUser: async () => ({ data: { user: { id: USER_ID, user_metadata: userMetadata } }, error: null }),
      admin: { updateUserById: async () => ({ error: null }) },
    },
  }),
}))

vi.mock("@/lib/rate-limiter", () => ({
  applyRateLimit: vi.fn(async () => ({ allowed: true, remaining: 100, resetAt: Date.now() })),
}))
vi.mock("@/lib/push-service", () => ({ notifyAdminsPush: vi.fn(async () => undefined) }))
vi.mock("@/lib/email-service", () => ({
  sendEmail: vi.fn(async () => undefined),
  EmailTemplates: { welcomeEmail: () => ({ subject: "s", html: "h" }) },
}))

import { POST } from "./route"

const SOURCE = { landing: "/mtn-data", ref: "www.google.com", utm_source: "google", at: "2026-10-28T10:00:00.000Z" }

function request(body: Record<string, unknown> = {}) {
  return new NextRequest("http://localhost/api/auth/signup", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer test-token" },
    body: JSON.stringify({ email: EMAIL, firstName: "Kofi", lastName: "Mensah", phoneNumber: PHONE, ...body }),
  })
}

const updates = () => calls.filter(c => c.table === "users" && c.op === "update")
const upserts = () => calls.filter(c => c.table === "users" && c.op === "upsert")

let warn: ReturnType<typeof vi.spyOn>
let error: ReturnType<typeof vi.spyOn>
let log: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  calls.length = 0
  userMetadata = {}
  updateResult = async () => ({ error: null })
  warn = vi.spyOn(console, "warn").mockImplementation(() => {})
  error = vi.spyOn(console, "error").mockImplementation(() => {})
  log = vi.spyOn(console, "log").mockImplementation(() => {})
})
afterEach(() => {
  warn.mockRestore()
  error.mockRestore()
  log.mockRestore()
})

function signupSourceLogs(): string {
  return [...warn.mock.calls, ...error.mock.calls, ...log.mock.calls]
    .map(a => a.map(String).join(" "))
    .filter(line => line.includes("signup_source"))
    .join("\n")
}

describe("POST /api/auth/signup — signup_source", () => {
  it("profile upsert succeeds and the response stays successful when the signup_source update errors (column missing)", async () => {
    userMetadata = { signup_source: SOURCE }
    updateResult = async () => ({ error: { code: "42703", message: 'column "signup_source" of relation "users" does not exist' } })

    const res = await POST(request())
    expect(res.status).toBe(201)
    expect(upserts()).toHaveLength(1)
    expect((await res.json()).profile).toEqual({ id: USER_ID })

    const [u] = updates()
    expect(u.payload).toEqual({ signup_source: SOURCE })
    expect(u.chain).toContainEqual(["eq", ["id", USER_ID]])
    expect(u.chain).toContainEqual(["is", ["signup_source", null]])

    const logged = signupSourceLogs()
    expect(logged).toContain("42703")
    for (const pii of [EMAIL, PHONE, USER_ID, "Kofi", "Mensah"]) expect(logged).not.toContain(pii)
  })

  it("still succeeds when the signup_source update throws", async () => {
    userMetadata = { signup_source: SOURCE }
    updateResult = async () => { throw new Error("network down") }
    const res = await POST(request())
    expect(res.status).toBe(201)
    expect(upserts()).toHaveLength(1)
  })

  it("the update runs only after the upsert", async () => {
    userMetadata = { signup_source: SOURCE }
    await POST(request())
    const idxUpsert = calls.findIndex(c => c.table === "users" && c.op === "upsert")
    const idxUpdate = calls.findIndex(c => c.table === "users" && c.op === "update")
    expect(idxUpsert).toBeGreaterThanOrEqual(0)
    expect(idxUpdate).toBeGreaterThan(idxUpsert)
  })

  it("uses the body signupSource (OAuth complete-profile path) when metadata has none", async () => {
    const res = await POST(request({ signupSource: SOURCE }))
    expect(res.status).toBe(201)
    expect(updates()[0]?.payload).toEqual({ signup_source: SOURCE })
  })

  it("prefers the auth metadata over the body", async () => {
    userMetadata = { signup_source: SOURCE }
    await POST(request({ signupSource: { ...SOURCE, landing: "/afa" } }))
    expect(updates()[0]?.payload).toEqual({ signup_source: SOURCE })
  })

  it("sanitizes hostile values and skips the update when nothing valid remains", async () => {
    userMetadata = { signup_source: { landing: "/<script>", at: "x".repeat(10_000) } }
    const res = await POST(request({ signupSource: "x".repeat(10_000) }))
    expect(res.status).toBe(201)
    expect(updates()).toHaveLength(0)
  })

  it("does not write when there is no attribution at all", async () => {
    const res = await POST(request())
    expect(res.status).toBe(201)
    expect(updates()).toHaveLength(0)
  })
})
