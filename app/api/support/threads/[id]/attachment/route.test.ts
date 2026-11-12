import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"
import { makeFakeDb, type FakeCall, type FakeResult } from "../../../_fake-db"

const h = vi.hoisted(() => ({ client: null as any, sign: vi.fn() }))

vi.mock("@supabase/supabase-js", () => ({ createClient: () => new Proxy({}, { get: (_t, k) => h.client[k] }) }))
vi.mock("@/lib/support-attachment", () => ({ signAttachmentUrl: (...a: any[]) => h.sign(...a) }))

import { GET } from "./route"

const CALLER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const THREAD = "44444444-4444-4444-8444-444444444444"

let fake: ReturnType<typeof makeFakeDb>

function install(owner: string | null, firstMessage: any, extra: (c: FakeCall) => FakeResult | undefined = () => undefined) {
  fake = makeFakeDb((c) => {
    const o = extra(c)
    if (o) return o
    if (c.table === "support_threads") {
      const asked = c.filters.find(([k]) => k === "user_id")?.[1]
      return { data: owner && asked === owner ? { id: THREAD } : null }
    }
    if (c.table === "support_messages") return { data: firstMessage }
    return undefined
  })
  h.client = {
    ...fake.db,
    auth: {
      getUser: async (t: string) =>
        t === "good" ? { data: { user: { id: CALLER } }, error: null } : { data: { user: null }, error: { message: "bad" } },
    },
  }
}

function call(id: string, token: string | null = "good") {
  const headers: Record<string, string> = {}
  if (token) headers.Authorization = `Bearer ${token}`
  return GET(new NextRequest(`http://localhost/api/support/threads/${id}/attachment`, { headers }), {
    params: Promise.resolve({ id }),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  h.sign.mockReset().mockImplementation(async (_db: unknown, path: string | null) => (path ? "https://signed.example/x" : null))
  install(CALLER, { attachment_path: `threads/${CALLER}/${THREAD}/a.png` })
})

describe("GET /api/support/threads/[id]/attachment", () => {
  it("401 without a token", async () => {
    expect((await call(THREAD, null)).status).toBe(401)
  })

  it("400 for a non-uuid id", async () => {
    expect((await call("nope")).status).toBe(400)
  })

  it("404 for another user's thread and never signs anything", async () => {
    install(OTHER, { attachment_path: `threads/${OTHER}/${THREAD}/a.png` })
    const res = await call(THREAD)
    expect(res.status).toBe(404)
    expect(h.sign).not.toHaveBeenCalled()
    expect(fake.calls.find((c) => c.table === "support_messages")).toBeUndefined()
  })

  it("filters the thread lookup by id and caller", async () => {
    await call(THREAD)
    const lookup = fake.calls.find((c) => c.table === "support_threads")!
    expect(lookup.filters).toContainEqual(["id", THREAD])
    expect(lookup.filters).toContainEqual(["user_id", CALLER])
  })

  it("own thread without an attachment returns url null", async () => {
    install(CALLER, { attachment_path: null })
    const res = await call(THREAD)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: { url: null } })
  })

  it("own thread with no messages returns url null", async () => {
    install(CALLER, null)
    expect((await (await call(THREAD)).json()).data.url).toBeNull()
  })

  it("returns a signed url for the caller's own attachment", async () => {
    const res = await call(THREAD)
    expect(await res.json()).toEqual({ success: true, data: { url: "https://signed.example/x" } })
    expect(h.sign.mock.calls[0][1]).toBe(`threads/${CALLER}/${THREAD}/a.png`)
  })
})
