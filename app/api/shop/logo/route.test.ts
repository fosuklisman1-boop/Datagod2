import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const { getUser, uploadShopLogo } = vi.hoisted(() => ({ getUser: vi.fn(), uploadShopLogo: vi.fn() }))
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ auth: { getUser } }) }))
vi.mock("@/lib/shop-logo", () => ({ uploadShopLogo }))

import { POST } from "./route"

function req(opts: { token?: string; file?: File | null } = {}) {
  const form = new FormData()
  if (opts.file !== null) form.append("file", opts.file ?? new File([new Uint8Array(10)], "logo.png", { type: "image/png" }))
  const headers: Record<string, string> = {}
  if (opts.token) headers.authorization = `Bearer ${opts.token}`
  return new NextRequest("http://localhost/api/shop/logo", { method: "POST", body: form, headers })
}

beforeEach(() => vi.clearAllMocks())

describe("POST /api/shop/logo", () => {
  it("401 without a bearer token; nothing uploaded", async () => {
    const res = await POST(req())
    expect(res.status).toBe(401)
    expect(uploadShopLogo).not.toHaveBeenCalled()
  })
  it("401 when the token does not resolve to a user", async () => {
    getUser.mockResolvedValue({ data: { user: null }, error: { message: "bad jwt" } })
    expect((await POST(req({ token: "t" }))).status).toBe(401)
    expect(uploadShopLogo).not.toHaveBeenCalled()
  })
  it("400 when no file is sent", async () => {
    getUser.mockResolvedValue({ data: { user: { id: "u1" } }, error: null })
    expect((await POST(req({ token: "t", file: null }))).status).toBe(400)
  })
  it("uploads for the authenticated user and returns the URL", async () => {
    getUser.mockResolvedValue({ data: { user: { id: "u1" } }, error: null })
    uploadShopLogo.mockResolvedValue({ ok: true, url: "https://cdn/x.png" })
    const res = await POST(req({ token: "t" }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ url: "https://cdn/x.png" })
    expect(uploadShopLogo.mock.calls[0][1].userId).toBe("u1")
  })
  it("passes through the library's error status", async () => {
    getUser.mockResolvedValue({ data: { user: { id: "u1" } }, error: null })
    uploadShopLogo.mockResolvedValue({ ok: false, status: 400, error: "Logo must be a JPG, PNG or WebP image" })
    const res = await POST(req({ token: "t" }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/JPG/)
  })
})
