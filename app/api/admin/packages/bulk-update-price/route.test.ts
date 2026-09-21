import { POST } from "./route"
import { NextRequest } from "next/server"
import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@/lib/admin-auth", () => ({
  verifyAdminAccess: vi.fn(async () => ({ isAdmin: true, userId: "admin-1" })),
}))

const h = vi.hoisted(() => {
  const state = {
    packagesRows: [
      { id: "pkg-1", price: 20, dealer_price: 18, size: "5" },
      { id: "pkg-2", price: 10, dealer_price: 9, size: "2" },
    ] as { id: string; price: number; dealer_price: number | null; size: string }[],
    updateCalls: [] as { id: string; data: any }[],
    auditInserts: [] as any[],
  }
  const fake = {
    from: (table: string) => {
      if (table === "packages") {
        return {
          select: () => ({
            in: (_col: string, ids: string[]) =>
              Promise.resolve({
                data: state.packagesRows.filter((p) => ids.includes(p.id)),
                error: null,
              }),
          }),
          update: (data: any) => ({
            eq: (_col: string, id: string) => {
              state.updateCalls.push({ id, data })
              return Promise.resolve({ error: null })
            },
          }),
        }
      }
      if (table === "admin_audit_log") {
        return {
          insert: (rows: any[]) => {
            state.auditInserts.push(...rows)
            return { then: (resolve: (v: { error: null }) => void) => resolve({ error: null }) }
          },
        }
      }
      throw new Error(`Unexpected table in fake client: ${table}`)
    },
  }
  return { state, fake }
})

vi.mock("@supabase/supabase-js", () => ({ createClient: () => h.fake }))

function postRequest(body: unknown) {
  return new NextRequest("http://localhost/api/admin/packages/bulk-update-price", {
    method: "POST",
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  h.state.packagesRows = [
    { id: "pkg-1", price: 20, dealer_price: 18, size: "5" },
    { id: "pkg-2", price: 10, dealer_price: 9, size: "2" },
  ]
  h.state.updateCalls = []
  h.state.auditInserts = []
})

describe("POST /api/admin/packages/bulk-update-price", () => {
  it("rejects an empty packageIds array", async () => {
    const res = await POST(postRequest({ packageIds: [], updates: { price: { mode: "percentage", value: 10 } } }))
    expect(res.status).toBe(400)
  })

  it("rejects a request with no updates", async () => {
    const res = await POST(postRequest({ packageIds: ["pkg-1"], updates: {} }))
    expect(res.status).toBe(400)
  })

  it("rejects an unknown mode", async () => {
    const res = await POST(
      postRequest({ packageIds: ["pkg-1"], updates: { price: { mode: "bogus", value: 10 } } })
    )
    expect(res.status).toBe(400)
  })

  it("rejects a non-finite value", async () => {
    const res = await POST(
      postRequest({ packageIds: ["pkg-1"], updates: { price: { mode: "percentage", value: Number.NaN } } })
    )
    expect(res.status).toBe(400)
  })

  it("applies a percentage price update to all requested packages", async () => {
    const res = await POST(
      postRequest({
        packageIds: ["pkg-1", "pkg-2"],
        updates: { price: { mode: "percentage", value: 10 } },
      })
    )
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.updated).toHaveLength(2)
    expect(body.skipped).toHaveLength(0)
    expect(h.state.updateCalls).toEqual(
      expect.arrayContaining([
        { id: "pkg-1", data: { price: 22 } },
        { id: "pkg-2", data: { price: 11 } },
      ])
    )
  })

  it("skips a package whose computed price would be non-positive, without failing the batch", async () => {
    const res = await POST(
      postRequest({
        packageIds: ["pkg-1", "pkg-2"],
        updates: { price: { mode: "percentage", value: -150 } },
      })
    )
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.updated).toHaveLength(0)
    expect(body.skipped).toHaveLength(2)
    expect(body.skipped[0].skip_reason).toBe("non_positive_price")
    expect(h.state.updateCalls).toHaveLength(0)
  })

  it("writes a best-effort admin_audit_log row", async () => {
    await POST(
      postRequest({
        packageIds: ["pkg-1"],
        updates: { price: { mode: "percentage", value: 10 } },
      })
    )
    expect(h.state.auditInserts).toHaveLength(1)
    expect(h.state.auditInserts[0]).toMatchObject({
      admin_id: "admin-1",
      action: "bulk_price_update",
    })
  })

  it("rejects when verifyAdminAccess denies access", async () => {
    const { verifyAdminAccess } = await import("@/lib/admin-auth")
    ;(verifyAdminAccess as any).mockResolvedValueOnce({
      isAdmin: false,
      errorResponse: new Response(JSON.stringify({ error: "Admin access required" }), { status: 403 }),
    })
    const res = await POST(
      postRequest({ packageIds: ["pkg-1"], updates: { price: { mode: "percentage", value: 10 } } })
    )
    expect(res.status).toBe(403)
  })
})
