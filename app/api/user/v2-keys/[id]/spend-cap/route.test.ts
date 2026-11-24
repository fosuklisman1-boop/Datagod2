import { describe, it, expect, vi, beforeEach } from "vitest"

const h = vi.hoisted(() => ({ user: null as { id: string } | null, rpc: vi.fn(), getUser: vi.fn() }))
vi.mock("@/lib/api-v2/store", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api-v2/store")>("@/lib/api-v2/store")
  return {
    ...actual,
    getAdminClient: () => ({
      auth: { getUser: (t: string) => (h.getUser(t), Promise.resolve({ data: { user: t === "session-token" ? h.user : null } })) },
      rpc: async (fn: string, args: unknown) => (h.rpc(fn, args), { data: { ok: true, changed: true }, error: null }),
      from: () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const chain: any = { select: () => chain, eq: () => chain, maybeSingle: async () => ({ data: { user_id: "u1", environment: "live" }, error: null }) }
        return chain
      },
    }),
  }
})
vi.mock("@/lib/api-v2/spend", async () => ({ getMoneySettings: () => ({ read: async () => ({ capsEnabled: false, alertsEnabled: false, at: 0 }) }) }))

import * as route from "./route"

const K = "22222222-2222-4222-8222-222222222222"
const req = (auth: string | null, body?: unknown) =>
  ({ headers: new Headers(auth ? { Authorization: `Bearer ${auth}` } : {}), json: async () => body }) as never
const ctx = { params: Promise.resolve({ id: K }) } as never

beforeEach(() => {
  h.user = { id: "u1" }
  h.rpc.mockReset()
})

describe("/api/user/v2-keys/[id]/spend-cap", () => {
  it("no session -> 401; an API key in Authorization is not a session -> 401; no rpc either way", async () => {
    for (const auth of [null, "dg2_live_abc123"]) {
      expect((await route.PUT(req(auth, { cap: 50 }), ctx)).status).toBe(401)
      expect((await route.GET(req(auth), ctx)).status).toBe(401)
    }
    expect(h.rpc).not.toHaveBeenCalled()
  })
  it("session: PUT saves with the session user as actor; GET answers no-store", async () => {
    const r = await route.PUT(req("session-token", { cap: 50 }), ctx)
    expect(r.status).toBe(200)
    expect(h.rpc).toHaveBeenCalledWith("api_v2_set_spend_cap", { p_scope: "key", p_scope_id: K, p_cap: 50, p_actor: "u1" })
    expect(r.headers.get("cache-control")).toBe("no-store")
  })
  it("PUT without a cap field -> 400; route exports only handlers", async () => {
    expect((await route.PUT(req("session-token", {}), ctx)).status).toBe(400)
    expect(Object.keys(route).sort()).toEqual(["GET", "PUT"])
  })
})
