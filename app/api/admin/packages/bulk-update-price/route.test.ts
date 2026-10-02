import { POST } from "./route"
import { NextRequest } from "next/server"
import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@/lib/admin-auth", () => ({
  verifyAdminAccess: vi.fn(async () => ({ isAdmin: true, userId: "admin-1" })),
}))

// packageIds must be UUID-shaped (route now validates this), so fixtures use
// real UUID-looking strings rather than "pkg-1" style ids.
const PKG1 = "11111111-1111-1111-1111-111111111111"
const PKG2 = "22222222-2222-2222-2222-222222222222"
const PKG_NOT_FOUND = "99999999-9999-9999-9999-999999999999"

const h = vi.hoisted(() => {
  const state = {
    packagesRows: [] as { id: string; price: number; dealer_price: number | null; size: string }[],
    updateCalls: [] as { id: string; data: any }[],
    auditInserts: [] as any[],
    // Set of package ids whose .update().eq() call should resolve with an
    // error, to simulate a partial write failure (DB constraint, transient
    // error, row deleted between SELECT and UPDATE, etc).
    failWriteForIds: new Set<string>(),
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
              if (state.failWriteForIds.has(id)) {
                return Promise.resolve({ error: new Error("simulated write failure") })
              }
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
    { id: PKG1, price: 20, dealer_price: 18, size: "5" },
    { id: PKG2, price: 10, dealer_price: 9, size: "2" },
  ]
  h.state.updateCalls = []
  h.state.auditInserts = []
  h.state.failWriteForIds = new Set()
})

describe("POST /api/admin/packages/bulk-update-price", () => {
  it("rejects an empty packageIds array", async () => {
    const res = await POST(postRequest({ packageIds: [], updates: { price: { mode: "percentage", value: 10 } } }))
    expect(res.status).toBe(400)
  })

  it("rejects a request with no updates", async () => {
    const res = await POST(postRequest({ packageIds: [PKG1], updates: {} }))
    expect(res.status).toBe(400)
  })

  it("rejects an unknown mode", async () => {
    const res = await POST(
      postRequest({ packageIds: [PKG1], updates: { price: { mode: "bogus", value: 10 } } })
    )
    expect(res.status).toBe(400)
  })

  it("rejects a non-finite value", async () => {
    const res = await POST(
      postRequest({ packageIds: [PKG1], updates: { price: { mode: "percentage", value: Number.NaN } } })
    )
    expect(res.status).toBe(400)
  })

  it("applies a percentage price update to all requested packages", async () => {
    const res = await POST(
      postRequest({
        packageIds: [PKG1, PKG2],
        updates: { price: { mode: "percentage", value: 10 } },
      })
    )
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.updated).toHaveLength(2)
    expect(body.skipped).toHaveLength(0)
    expect(h.state.updateCalls).toEqual(
      expect.arrayContaining([
        { id: PKG1, data: { price: 22 } },
        { id: PKG2, data: { price: 11 } },
      ])
    )
  })

  it("skips a package whose computed price would be non-positive, without failing the batch", async () => {
    const res = await POST(
      postRequest({
        packageIds: [PKG1, PKG2],
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
        packageIds: [PKG1],
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
      postRequest({ packageIds: [PKG1], updates: { price: { mode: "percentage", value: 10 } } })
    )
    expect(res.status).toBe(403)
  })

  it("reports a partial write failure as skipped, not updated, and still applies the successful write", async () => {
    h.state.failWriteForIds = new Set([PKG2])
    const res = await POST(
      postRequest({
        packageIds: [PKG1, PKG2],
        updates: { price: { mode: "percentage", value: 10 } },
      })
    )
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.updated).toHaveLength(1)
    expect(body.updated[0].id).toBe(PKG1)
    expect(body.skipped).toHaveLength(1)
    expect(body.skipped[0]).toMatchObject({ id: PKG2, skip_reason: "write_failed" })
    // Both writes were attempted even though only one "succeeded".
    expect(h.state.updateCalls).toEqual(
      expect.arrayContaining([
        { id: PKG1, data: { price: 22 } },
        { id: PKG2, data: { price: 11 } },
      ])
    )
  })

  it("reports requested ids that don't exist in the DB as not_found", async () => {
    const res = await POST(
      postRequest({
        packageIds: [PKG1, PKG_NOT_FOUND],
        updates: { price: { mode: "percentage", value: 10 } },
      })
    )
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.not_found).toEqual([PKG_NOT_FOUND])
    expect(body.updated).toHaveLength(1)
    expect(body.updated[0].id).toBe(PKG1)
  })

  it("updates only dealer_price when updates.dealer_price is set and updates.price is not", async () => {
    const res = await POST(
      postRequest({
        packageIds: [PKG1],
        updates: { dealer_price: { mode: "percentage", value: 10 } },
      })
    )
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.updated).toHaveLength(1)
    expect(h.state.updateCalls).toEqual([{ id: PKG1, data: { dealer_price: 19.8 } }])
  })

  it("updates both price and dealer_price together in one write", async () => {
    const res = await POST(
      postRequest({
        packageIds: [PKG1],
        updates: {
          price: { mode: "percentage", value: 10 },
          dealer_price: { mode: "percentage", value: 5 },
        },
      })
    )
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.updated).toHaveLength(1)
    expect(h.state.updateCalls).toEqual([{ id: PKG1, data: { price: 22, dealer_price: 18.9 } }])
  })
})
