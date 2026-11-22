import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const h = vi.hoisted(() => ({ stored: {} as Record<string, unknown>, upserted: null as null | Record<string, unknown>, admin: true }))

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { value: h.stored }, error: null }) }) }),
      upsert: async (row: { value: Record<string, unknown> }) => { h.upserted = row.value; return { error: null } },
    }),
  }),
}))
vi.mock("@/lib/admin-auth", () => ({
  verifyAdminAccess: async () => h.admin
    ? { isAdmin: true, userId: "a", errorResponse: null }
    : { isAdmin: false, userId: null, errorResponse: new Response("no", { status: 403 }) },
}))

import { GET, PUT } from "./route"

const put = (body: unknown) => PUT(new NextRequest("http://localhost/api/admin/ai-config", { method: "PUT", body: JSON.stringify(body) }))

beforeEach(() => {
  h.stored = { anthropic_api_key: "sk-ant-secret-key-1234567890" }
  h.upserted = null
  h.admin = true
})

describe("ai_config_put_validates_and_masks", () => {
  it("saves valid settings merged in, keeps the API key untouched, GET never returns it raw", async () => {
    const res = await put({ assistant_name: "Kofi Bot", tone: "friendly", audiences: { admins: true, signedIn: true, shopVisitors: false, publicVisitors: true }, max_tool_steps: 8 })
    expect(res.status).toBe(200)
    expect(h.upserted).toMatchObject({ anthropic_api_key: "sk-ant-secret-key-1234567890", assistant_name: "Kofi Bot", tone: "friendly", max_tool_steps: 8 })
    expect((h.upserted as any).audiences.shopVisitors).toBe(false)

    h.stored = h.upserted!
    const got = await (await GET(new NextRequest("http://localhost/api/admin/ai-config"))).json()
    expect(got).toMatchObject({ assistant_name: "Kofi Bot", tone: "friendly", max_tool_steps: 8 })
    expect(got.audiences.shopVisitors).toBe(false)
    expect(JSON.stringify(got)).not.toContain("secret-key-1234567890")
  })

  it("rejects invalid settings with 400 and writes nothing", async () => {
    for (const bad of [{ max_tool_steps: 2 }, { tone: "rude" }, { assistant_name: "x" }, { audiences: { admins: "yes" } }]) {
      const res = await put(bad)
      expect(res.status).toBe(400)
    }
    expect(h.upserted).toBeNull()
  })

  const PROVIDERS = ["anthropic", "openai", "gemini", "deepseek", "groq"] as const
  const getJson = async () => (await GET(new NextRequest("http://localhost/api/admin/ai-config"))).json()

  it.each(PROVIDERS)("GET shows only the last 4 characters of the %s key", async (p) => {
    const key = "sk-FAKEabcdefghijklmnopqrstWXYZ"
    h.stored = { [`${p}_api_key`]: key }
    const got = await getJson()
    expect(got[`${p}_api_key_masked`]).toBe("ends in WXYZ")
    expect(got[`${p}_key_set`]).toBe(true)
    const body = JSON.stringify(got)
    for (let i = 0; i + 5 <= key.length; i++) expect(body).not.toContain(key.slice(i, i + 5))
  })

  it.each(["sk-12345", "fifteen-chars15"])("GET shows nothing of a key too short to mask safely (%s)", async (key) => {
    h.stored = { deepseek_api_key: key }
    const got = await getJson()
    expect(got.deepseek_api_key_masked).toBe("")
    expect(got.deepseek_key_set).toBe(true)
  })

  it("GET masks from 16 characters", async () => {
    h.stored = { deepseek_api_key: "sixteen-charWXYZ" }
    expect((await getJson()).deepseek_api_key_masked).toBe("ends in WXYZ")
  })

  it("GET ignores whitespace pasted around a key", async () => {
    h.stored = { deepseek_api_key: "  sk-FAKEabcdefghijklmnopqrstWXYZ \n" }
    expect((await getJson()).deepseek_api_key_masked).toBe("ends in WXYZ")
  })

  it("GET still loads when a stored key is not text", async () => {
    h.stored = { deepseek_api_key: 12345678901234567890, groq_api_key: { x: 1 } }
    const res = await GET(new NextRequest("http://localhost/api/admin/ai-config"))
    expect(res.status).toBe(200)
    const got = await res.json()
    expect(got.deepseek_api_key_masked).toBe("")
    expect(got.groq_api_key_masked).toBe("")
  })

  it("GET refuses non-admins", async () => {
    h.admin = false
    expect((await GET(new NextRequest("http://localhost/api/admin/ai-config"))).status).toBe(403)
  })

  it("GET defaults when nothing stored; non-admins are refused", async () => {
    h.stored = {}
    const got = await (await GET(new NextRequest("http://localhost/api/admin/ai-config"))).json()
    expect(got).toMatchObject({ assistant_name: "DATAGOD AI", tone: "default", max_tool_steps: null })
    h.admin = false
    expect((await put({ tone: "fun" })).status).toBe(403)
    expect(h.upserted).toBeNull()
  })
})
