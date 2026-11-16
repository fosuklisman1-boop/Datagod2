import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"
import { ADMIN_ID, createFakeDb, USER_ID, type FakeDb, type FakeQuery, type GateMode } from "@/lib/admin-users/test-fake-db"

const h = vi.hoisted(() => ({ gate: "admin" as GateMode, fake: null as unknown as FakeDb, notes: [] as any[] }))
vi.mock("@/lib/admin-auth", () => ({
  verifyAdminAccess: vi.fn(async () => (await import("@/lib/admin-users/test-fake-db")).fakeVerify(h.gate)),
}))
vi.mock("@supabase/supabase-js", () => ({ createClient: () => new Proxy({}, { get: (_t, k) => (h.fake.db as any)[k] }) }))

import { GET as RAW_GET, POST as RAW_POST } from "./route"
import { DELETE as RAW_DELETE, PATCH as RAW_PATCH } from "./[noteId]/route"

const OTHER_ADMIN = "22222222-2222-4222-8222-222222222222"
const NOTE_MINE = "bbbbbbbb-bbbb-4bbb-8bbb-000000000001"
const NOTE_THEIRS = "bbbbbbbb-bbbb-4bbb-8bbb-000000000002"
const url = `http://x/api/admin/users/${USER_ID}/notes`
const ctx = (id = USER_ID) => ({ params: Promise.resolve({ id }) })
const nctx = (noteId: string, id = USER_ID) => ({ params: Promise.resolve({ id, noteId }) })
const GET = async (id = USER_ID) => (await RAW_GET(new NextRequest(url), ctx(id)))!
const POST = async (body: unknown, id = USER_ID) => (await RAW_POST(new NextRequest(url, { method: "POST", body: JSON.stringify(body) }), ctx(id)))!
const PATCH = async (noteId: string, body: unknown) =>
  (await RAW_PATCH(new NextRequest(`${url}/${noteId}`, { method: "PATCH", body: JSON.stringify(body) }), nctx(noteId)))!
const DELETE = async (noteId: string) => (await RAW_DELETE(new NextRequest(`${url}/${noteId}`, { method: "DELETE" }), nctx(noteId)))!

const audits = () => h.fake.ofTable("admin_audit_log").flatMap((q) => q.payload as any[])

beforeEach(() => {
  h.gate = "admin"
  h.notes = [
    { id: NOTE_MINE, user_id: USER_ID, author_id: ADMIN_ID, body: "mine", created_at: "2026-11-01T00:00:00Z", updated_at: "2026-11-01T00:00:00Z" },
    { id: NOTE_THEIRS, user_id: USER_ID, author_id: OTHER_ADMIN, body: "theirs", created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z" },
  ]
  h.fake = createFakeDb({
    tables: {
      admin_user_notes: (q: FakeQuery) => {
        if (q.kind === "insert") return { data: { id: "new-note", ...(q.payload as object), created_at: "t", updated_at: "t" }, error: null }
        if (q.kind === "delete") return { data: null, error: null }
        if (q.kind === "update") {
          const m = h.notes.find((x) => x.id === q.filter("id") && x.author_id === q.filter("author_id"))
          return { data: m ? { ...m, ...(q.payload as object) } : null, error: null }
        }
        const n = h.notes.find((x) => x.id === q.filter("id") && x.user_id === q.filter("user_id"))
        if (q.filter("id")) return { data: n ?? null, error: null }
        return { data: h.notes.filter((x) => x.user_id === q.filter("user_id")), error: null }
      },
      users: () => ({ data: [{ id: ADMIN_ID, email: "boss@example.com" }, { id: OTHER_ADMIN, email: "other@example.com" }], error: null }),
      admin_audit_log: () => ({ data: null, error: null }),
    },
  })
})

describe("/api/admin/users/[id]/notes", () => {
  it("lists notes newest first with author emails (reads allow any admin gate result that verifyAdminAccess allows)", async () => {
    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.notes.map((n: any) => [n.id, n.author_email])).toEqual([[NOTE_MINE, "boss@example.com"], [NOTE_THEIRS, "other@example.com"]])
    const q = h.fake.ofTable("admin_user_notes")[0]
    expect(q.op("order")).toEqual(["order", "created_at", { ascending: false }])
    expect(q.op("limit")).toEqual(["limit", 100])
  })

  it("gate: 403 / 429 for reads and writes; writes refuse the CRON bypass", async () => {
    h.gate = "forbidden"
    expect((await GET()).status).toBe(403)
    expect((await POST({ body: "x" })).status).toBe(403)
    h.gate = "rate_limited"
    expect((await POST({ body: "x" })).status).toBe(429)
    h.gate = "cron"
    expect((await POST({ body: "x" })).status).toBe(403)
    expect((await PATCH(NOTE_MINE, { body: "x" })).status).toBe(403)
    expect((await DELETE(NOTE_MINE)).status).toBe(403)
    expect(h.fake.ofTable("admin_user_notes").filter((q) => q.kind !== "select")).toHaveLength(0)
  })

  it("validates the user id and the body", async () => {
    expect((await GET("nope")).status).toBe(400)
    expect((await POST({ body: "   " })).status).toBe(400)
    expect((await POST({ body: "x".repeat(2001) })).status).toBe(400)
    expect((await POST({})).status).toBe(400)
    expect(h.fake.ofTable("admin_user_notes")).toHaveLength(0)
  })

  it("creates a note as the acting admin, trimmed, and audits it", async () => {
    const res = await POST({ body: "  called about a refund  " })
    expect(res.status).toBe(201)
    expect(h.fake.ofTable("admin_user_notes")[0].payload).toEqual({ user_id: USER_ID, author_id: ADMIN_ID, body: "called about a refund" })
    expect(audits()).toEqual([{ admin_id: ADMIN_ID, action: "user_note_create", target_user_id: USER_ID, old_value: null,
      new_value: { note_id: "new-note", body: "called about a refund" } }])
  })

  it("edits only your own note, and audits old and new", async () => {
    const theirs = await PATCH(NOTE_THEIRS, { body: "changed" })
    expect(theirs.status).toBe(403)
    const res = await PATCH(NOTE_MINE, { body: "mine, edited" })
    expect(res.status).toBe(200)
    const upd = h.fake.ofTable("admin_user_notes").find((q) => q.kind === "update")!
    expect(upd.payload).toMatchObject({ body: "mine, edited" })
    expect(upd.filter("author_id")).toBe(ADMIN_ID)
    expect(audits()).toEqual([{ admin_id: ADMIN_ID, action: "user_note_update", target_user_id: USER_ID,
      old_value: { note_id: NOTE_MINE, body: "mine" }, new_value: { note_id: NOTE_MINE, body: "mine, edited" } }])
  })

  it("any admin may delete any note; audited with the deleted text", async () => {
    const res = await DELETE(NOTE_THEIRS)
    expect(res.status).toBe(200)
    expect(audits()).toEqual([{ admin_id: ADMIN_ID, action: "user_note_delete", target_user_id: USER_ID,
      old_value: { note_id: NOTE_THEIRS, body: "theirs", author_id: OTHER_ADMIN }, new_value: null }])
  })

  it("404s a note of another user or an unknown note; 400s a bad note id", async () => {
    expect((await DELETE("bbbbbbbb-bbbb-4bbb-8bbb-000000000009")).status).toBe(404)
    expect((await DELETE("nope")).status).toBe(400)
    expect(audits()).toHaveLength(0)
  })
})
