import { describe, it, expect, beforeEach, vi } from "vitest"

const h = vi.hoisted(() => {
  const state = {
    listData: [] as unknown[],
    insertPayload: null as Record<string, unknown> | null,
    insertReturn: { id: "t1", name: "Promo", body: "Hi", created_at: "", updated_at: "" } as unknown,
    insertError: null as { message: string } | null,
    deleteReturn: [{ id: "t1" }] as { id: string }[],
  }
  const fake = {
    from: (_t: string) => ({
      select: (_c?: string) => ({
        eq: (_col: string, _v: string) => ({
          order: (_o1?: string, _o2?: unknown) => Promise.resolve({ data: state.listData, error: null }),
        }),
      }),
      insert: (row: Record<string, unknown>) => {
        state.insertPayload = row
        return {
          select: (_c?: string) => ({
            single: () => Promise.resolve({ data: state.insertError ? null : state.insertReturn, error: state.insertError }),
          }),
        }
      },
      delete: () => ({
        eq: (_c: string, _v: string) => ({
          eq: (_c2: string, _v2: string) => ({
            select: (_c3?: string) => Promise.resolve({ data: state.deleteReturn, error: null }),
          }),
        }),
      }),
    }),
  }
  return { state, fake }
})

vi.mock("@supabase/supabase-js", () => ({ createClient: () => h.fake }))

import { listTenantTemplates, createTenantTemplate, deleteTenantTemplate } from "./tenant-templates-service"

beforeEach(() => {
  h.state.listData = []
  h.state.insertPayload = null
  h.state.insertError = null
  h.state.deleteReturn = [{ id: "t1" }]
})

describe("createTenantTemplate", () => {
  it("stamps the owning account on the inserted row", async () => {
    const res = await createTenantTemplate("acc-1", "Promo", "Hi {shop_name}")
    expect(res.ok).toBe(true)
    expect(h.state.insertPayload).toMatchObject({ name: "Promo", body: "Hi {shop_name}", sms_account_id: "acc-1" })
  })

  it("rejects an empty name and an over-long body without inserting", async () => {
    const r1 = await createTenantTemplate("acc-1", "  ", "Hi")
    expect(r1.ok).toBe(false)
    const r2 = await createTenantTemplate("acc-1", "Name", "x".repeat(1001))
    expect(r2.ok).toBe(false)
    expect(h.state.insertPayload).toBeNull()
  })
})

describe("deleteTenantTemplate", () => {
  it("deletes when the account owns the template", async () => {
    h.state.deleteReturn = [{ id: "t1" }]
    const res = await deleteTenantTemplate("acc-1", "t1")
    expect(res.ok).toBe(true)
  })

  it("returns 'not found' when nothing was deleted (wrong owner / missing)", async () => {
    h.state.deleteReturn = []
    const res = await deleteTenantTemplate("acc-1", "t-other")
    expect(res.ok).toBe(false)
    expect((res as { error: string }).error).toMatch(/not found/i)
  })
})

describe("listTenantTemplates", () => {
  it("returns the account's templates", async () => {
    h.state.listData = [{ id: "t1", name: "Promo", body: "Hi", created_at: "", updated_at: "" }]
    const res = await listTenantTemplates("acc-1")
    expect(res.ok).toBe(true)
    expect((res as { data: unknown[] }).data).toHaveLength(1)
  })
})
