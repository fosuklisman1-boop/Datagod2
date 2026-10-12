import { describe, it, expect, vi, afterEach } from "vitest"
import { DB_SESSION_TTL_SECONDS, dbSessionStore } from "./session"
import type { HubtelSession } from "./types"

const s: HubtelSession = { step: "MAIN", dialingPhone: "+233200585542", platform: "USSD" }

/** Minimal fake of the calls dbSessionStore makes on hubtel_ussd_sessions. */
function fakeDb(fail = false) {
  const rows = new Map<string, { data: HubtelSession; expires_at: string }>()
  const err = fail ? { code: "42P01", message: "relation does not exist" } : null
  const client = {
    from: () => ({
      select: () => ({ eq: (_c: string, id: string) => ({ maybeSingle: async () => (err ? { data: null, error: err } : { data: rows.get(id) ?? null, error: null }) }) }),
      upsert: async (r: { session_id: string; data: HubtelSession; expires_at: string }) => {
        if (err) return { error: err }
        rows.set(r.session_id, { data: r.data, expires_at: r.expires_at })
        return { error: null }
      },
      delete: () => ({
        eq: async (_c: string, id: string) => { if (!err) rows.delete(id); return { error: err } },
        lt: async (_c: string, iso: string) => { for (const [k, v] of rows) if (v.expires_at < iso) rows.delete(k); return { error: err } },
      }),
    }),
  }
  return { client: client as never, rows }
}

describe("dbSessionStore (Postgres only)", () => {
  afterEach(() => { vi.restoreAllMocks() })

  it("round-trips through the table and deletes", async () => {
    const { client, rows } = fakeDb()
    const store = dbSessionStore(client)
    await store.set("d1", s)
    expect(rows.has("d1")).toBe(true)
    expect(await store.get("d1")).toEqual(s)
    await store.del("d1")
    expect(await store.get("d1")).toBeNull()
  })
  it("an expired row is a miss", async () => {
    let t = 1_000_000
    const { client } = fakeDb()
    const store = dbSessionStore(client, () => t)
    await store.set("d2", s)
    t += (DB_SESSION_TTL_SECONDS + 1) * 1000
    expect(await store.get("d2")).toBeNull()
  })
  it("a failing DB is a miss and never throws (no second store to go stale)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const { client } = fakeDb(true)
    const store = dbSessionStore(client)
    await expect(store.set("d3", s)).resolves.toBeUndefined()
    expect(await store.get("d3")).toBeNull()
    await expect(store.del("d3")).resolves.toBeUndefined()
  })
})
