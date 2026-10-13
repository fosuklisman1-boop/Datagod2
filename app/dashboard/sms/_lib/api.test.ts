import { describe, it, expect, vi, beforeEach } from "vitest"

const h = vi.hoisted(() => ({ getSession: vi.fn() }))
vi.mock("@/lib/supabase", () => ({ supabase: { auth: { getSession: h.getSession } } }))

import { smsFetch } from "./api"

const fetchMock = vi.fn()
beforeEach(() => {
  fetchMock.mockReset(); vi.stubGlobal("fetch", fetchMock)
  h.getSession.mockReset(); h.getSession.mockResolvedValue({ data: { session: { access_token: "tok" } } })
})
const res = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body })

describe("smsFetch", () => {
  it("sends the bearer token and unwraps { data }", async () => {
    fetchMock.mockResolvedValue(res(200, { success: true, data: { a: 1 } }))
    const r = await smsFetch("/x", { method: "POST", body: "{}" })
    expect(r).toMatchObject({ ok: true, data: { a: 1 } })
    const init = fetchMock.mock.calls[0][1]
    expect(init.headers).toMatchObject({ Authorization: "Bearer tok", "Content-Type": "application/json" })
  })
  it("returns the bare body when there is no data key", async () => {
    fetchMock.mockResolvedValue(res(200, { account: { id: "1" } }))
    const r = await smsFetch<{ account: { id: string } }>("/x")
    expect(r.ok && r.data.account.id).toBe("1")
  })
  it("maps error bodies, with code", async () => {
    fetchMock.mockResolvedValue(res(403, { error: "nope", code: "OTP_REQUIRED" }))
    expect(await smsFetch("/x")).toMatchObject({ ok: false, status: 403, error: "nope", code: "OTP_REQUIRED" })
  })
  it("never throws: network error, token failure, null JSON body", async () => {
    fetchMock.mockRejectedValue(new Error("down"))
    expect(await smsFetch("/x")).toMatchObject({ ok: false, status: 0, error: "down" })
    h.getSession.mockRejectedValue(new Error("auth boom"))
    expect(await smsFetch("/x")).toMatchObject({ ok: false, status: 0, error: "auth boom" })
    h.getSession.mockResolvedValue({ data: { session: null } })
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => null })
    expect(await smsFetch("/x")).toMatchObject({ ok: false, status: 500, error: "HTTP 500", body: {} })
  })
})
