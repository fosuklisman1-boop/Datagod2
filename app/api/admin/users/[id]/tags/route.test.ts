import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"
import { ADMIN_ID, createFakeDb, USER_ID, type FakeDb, type FakeQuery, type GateMode } from "@/lib/admin-users/test-fake-db"

const h = vi.hoisted(() => ({ gate: "admin" as GateMode, fake: null as unknown as FakeDb, tags: [] as string[] }))
vi.mock("@/lib/admin-auth", () => ({
  verifyAdminAccess: vi.fn(async () => (await import("@/lib/admin-users/test-fake-db")).fakeVerify(h.gate)),
}))
vi.mock("@supabase/supabase-js", () => ({ createClient: () => new Proxy({}, { get: (_t, k) => (h.fake.db as any)[k] }) }))

import { GET as RAW_GET, POST as RAW_POST } from "./route"

const url = `http://x/api/admin/users/${USER_ID}/tags`
const ctx = (id = USER_ID) => ({ params: Promise.resolve({ id }) })
const GET = async () => (await RAW_GET(new NextRequest(url), ctx()))!
const POST = async (body: unknown, id = USER_ID) => (await RAW_POST(new NextRequest(url, { method: "POST", body: JSON.stringify(body) }), ctx(id)))!
const audits = () => h.fake.ofTable("admin_audit_log").flatMap((q) => q.payload as any[])

beforeEach(() => {
  h.gate = "admin"
  h.tags = ["reseller", "vip"]
  h.fake = createFakeDb({
    tables: {
      admin_user_tags: (q: FakeQuery) => {
        if (q.kind === "delete") { const rm = q.op("in")![2] as string[]; h.tags = h.tags.filter((t) => !rm.includes(t)); return { data: null, error: null } }
        if (q.kind === "upsert") { for (const r of q.payload as any[]) if (!h.tags.includes(r.tag)) h.tags.push(r.tag); h.tags.sort(); return { data: null, error: null } }
        return { data: h.tags.map((tag) => ({ tag })), error: null }
      },
      admin_audit_log: () => ({ data: null, error: null }),
    },
  })
})

describe("/api/admin/users/[id]/tags", () => {
  it("lists the tags and the suggestions", async () => {
    expect(await (await GET()).json()).toEqual({ tags: ["reseller", "vip"], suggested: ["vip", "fraud-watch", "bulk-buyer", "reseller", "support-priority"] })
  })

  it("gate: writes refuse 403, 429 and the CRON bypass", async () => {
    for (const g of ["forbidden", "rate_limited", "cron"] as const) {
      h.gate = g
      expect((await POST({ add: ["x"] })).status, g).toBe(g === "rate_limited" ? 429 : 403)
    }
    expect(h.fake.queries).toHaveLength(0)
  })

  it("validates", async () => {
    expect((await POST({ add: ["Bad Tag"] })).status).toBe(400)
    expect((await POST({})).status).toBe(400)
    expect((await POST({ add: ["x"] }, "nope")).status).toBe(400)
    expect(h.fake.queries).toHaveLength(0)
  })

  it("adds and removes (normalised), as the acting admin, with one audit row", async () => {
    const res = await POST({ add: ["Fraud-Watch", "vip"], remove: ["reseller", "never-had"] })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ tags: ["fraud-watch", "vip"], changed: true, audited: true })
    const up = h.fake.ofTable("admin_user_tags").find((q) => q.kind === "upsert")!
    expect(up.payload).toEqual([{ user_id: USER_ID, tag: "fraud-watch", created_by: ADMIN_ID }])
    expect(audits()).toEqual([{ admin_id: ADMIN_ID, action: "user_tags_change", target_user_id: USER_ID,
      old_value: { tags: ["reseller", "vip"] }, new_value: { tags: ["fraud-watch", "vip"], added: ["fraud-watch"], removed: ["reseller"] } }])
  })

  it("a change that changes nothing writes nothing", async () => {
    expect(await (await POST({ add: ["vip"], remove: ["nope"] })).json()).toEqual({ tags: ["reseller", "vip"], changed: false, audited: false })
    expect(audits()).toHaveLength(0)
  })

  it("caps a user at 20 tags", async () => {
    h.tags = Array.from({ length: 20 }, (_, i) => `t${i}`)
    expect((await POST({ add: ["one-more"] })).status).toBe(400)
  })
})
