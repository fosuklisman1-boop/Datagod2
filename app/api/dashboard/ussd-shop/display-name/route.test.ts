import { POST } from "./route"
import { NextRequest } from "next/server"
import { describe, it, expect, vi, beforeEach } from "vitest"

const h = vi.hoisted(() => {
  const state = {
    authUser: { id: "user-1" } as { id: string } | null,
    shopRow: { id: "shop-1" } as { id: string } | null,
    updateCalls: [] as { id: string; data: any }[],
    failUpdate: false,
  }
  const fake = {
    auth: {
      getUser: async (_token: string) => ({ data: { user: state.authUser } }),
    },
    from: (table: string) => {
      if (table === "user_shops") {
        return {
          select: () => ({
            eq: (_col: string, _val: string) => ({
              single: () => Promise.resolve({ data: state.shopRow }),
            }),
          }),
          update: (data: any) => ({
            eq: (_col: string, id: string) => {
              state.updateCalls.push({ id, data })
              return Promise.resolve({ error: state.failUpdate ? new Error("simulated failure") : null })
            },
          }),
        }
      }
      throw new Error(`Unexpected table in fake client: ${table}`)
    },
  }
  return { state, fake }
})

vi.mock("@supabase/supabase-js", () => ({ createClient: () => h.fake }))

function postRequest(body: unknown, withAuth = true) {
  return new NextRequest("http://localhost/api/dashboard/ussd-shop/display-name", {
    method: "POST",
    headers: withAuth ? { Authorization: "Bearer test-token" } : {},
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  h.state.authUser = { id: "user-1" }
  h.state.shopRow = { id: "shop-1" }
  h.state.updateCalls = []
  h.state.failUpdate = false
})

describe("POST /api/dashboard/ussd-shop/display-name", () => {
  it("rejects a request with no Authorization header", async () => {
    const res = await POST(postRequest({ name: "Kwame Shop" }, false))
    expect(res.status).toBe(401)
  })

  it("rejects when the token doesn't resolve to a user", async () => {
    h.state.authUser = null
    const res = await POST(postRequest({ name: "Kwame Shop" }))
    expect(res.status).toBe(401)
  })

  it("rejects a name containing a blocked word and does not write", async () => {
    const res = await POST(postRequest({ name: "MTN Direct Shop" }))
    const body = await res.json()
    expect(res.status).toBe(400)
    expect(body.error).toContain("mtn")
    expect(h.state.updateCalls).toHaveLength(0)
  })

  it("rejects when no shop is found for the authenticated user", async () => {
    h.state.shopRow = null
    const res = await POST(postRequest({ name: "Kwame Shop" }))
    expect(res.status).toBe(404)
  })

  it("saves a valid trimmed name and returns it", async () => {
    const res = await POST(postRequest({ name: "  Kwame Shop  " }))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body).toEqual({ success: true, ussd_display_name: "Kwame Shop" })
    expect(h.state.updateCalls).toEqual([{ id: "shop-1", data: { ussd_display_name: "Kwame Shop" } }])
  })

  it("returns success on repeated saves of the same valid name", async () => {
    const first = await POST(postRequest({ name: "Kwame Shop" }))
    const second = await POST(postRequest({ name: "Kwame Shop" }))
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(h.state.updateCalls).toHaveLength(2)
  })

  it("reports a DB update failure as a 500 without claiming success", async () => {
    h.state.failUpdate = true
    const res = await POST(postRequest({ name: "Kwame Shop" }))
    expect(res.status).toBe(500)
  })

  it("treats an empty name as clearing the override, writing null and reverting to shop_name", async () => {
    const res = await POST(postRequest({ name: "" }))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body).toEqual({ success: true, ussd_display_name: null })
    expect(h.state.updateCalls).toEqual([{ id: "shop-1", data: { ussd_display_name: null } }])
  })

  it("treats a whitespace-only name as clearing the override too", async () => {
    const res = await POST(postRequest({ name: "   " }))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body).toEqual({ success: true, ussd_display_name: null })
  })
})
