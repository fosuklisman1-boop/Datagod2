import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const h = vi.hoisted(() => ({ stored: {} as Record<string, unknown>, upserted: null as null | Record<string, unknown> }))

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { value: h.stored }, error: null }) }) }),
      upsert: async (row: { value: Record<string, unknown> }) => { h.upserted = row.value; return { error: null } },
    }),
  }),
}))
vi.mock("@/lib/admin-auth", () => ({
  verifyAdminAccess: async () => ({ isAdmin: true, userId: "a", errorResponse: null }),
}))

import { GET, PUT } from "./route"
import { assistantSettingsInputSchema, resolveAssistantSettings } from "@/lib/ai-console/settings"

const put = (body: unknown) => PUT(new NextRequest("http://localhost/api/admin/ai-config", { method: "PUT", body: JSON.stringify(body) }))

beforeEach(() => {
  h.stored = {}
  h.upserted = null
})

describe("admin_catalog_enabled", () => {
  it("defaults to false and resolves leniently", () => {
    expect(resolveAssistantSettings({}).adminCatalog).toBe(false)
    expect(resolveAssistantSettings({ admin_catalog_enabled: "yes" }).adminCatalog).toBe(false)
    expect(resolveAssistantSettings({ admin_catalog_enabled: true }).adminCatalog).toBe(true)
    expect(assistantSettingsInputSchema.safeParse({ admin_catalog_enabled: true }).success).toBe(true)
  })

  it("PUT saves a boolean and GET returns it", async () => {
    expect((await put({ admin_catalog_enabled: true })).status).toBe(200)
    expect(h.upserted).toMatchObject({ admin_catalog_enabled: true })
    h.stored = h.upserted!
    const got = await (await GET(new NextRequest("http://localhost/api/admin/ai-config"))).json()
    expect(got.admin_catalog_enabled).toBe(true)
  })

  it("GET reports false when never set", async () => {
    const got = await (await GET(new NextRequest("http://localhost/api/admin/ai-config"))).json()
    expect(got.admin_catalog_enabled).toBe(false)
  })

  it.each(["yes", 1, "true", null, {}])("PUT rejects a non-boolean (%j) and writes nothing", async (bad) => {
    expect((await put({ admin_catalog_enabled: bad })).status).toBe(400)
    expect(h.upserted).toBeNull()
  })
})
