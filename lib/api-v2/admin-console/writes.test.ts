import { describe, it, expect, vi, beforeEach } from "vitest"
import { setDeveloperPause } from "./developers"
import { setServicePause } from "./services"
import { saveAnnouncement, deleteAnnouncement } from "./announcements"

const UID = "11111111-1111-4111-8111-111111111111"
const ADMIN = "22222222-2222-4222-8222-222222222222"

function client(data: unknown = { ok: true, changed: true }, error: any = null) {
  const rpc = vi.fn(async (..._a: any[]): Promise<any> => ({ data, error }))
  return { rpc, c: { rpc, from() { throw new Error("no db") } } as any }
}
const ann = (o: Record<string, unknown> = {}) => ({
  id: null as string | null,
  title: "Planned maintenance",
  body: "We will be down briefly.",
  severity: "info",
  startsAt: "2026-12-01T10:00:00Z",
  endsAt: "2026-12-01T12:00:00Z",
  actorId: ADMIN as string | undefined,
  ...o,
})

describe("no admin id", () => {
  it("every write with actorId undefined -> 403 and zero rpc calls", async () => {
    const { rpc, c } = client()
    const inv = vi.fn()
    const rs = await Promise.all([
      setDeveloperPause(c, { userId: UID, paused: true, reason: "Abuse seen", actorId: undefined }, { invalidate: inv }),
      setServicePause(c, { service: "data", paused: true, message: null, actorId: undefined }, { invalidate: inv }),
      saveAnnouncement(c, ann({ actorId: undefined })),
      deleteAnnouncement(c, { id: UID, actorId: undefined }),
    ])
    expect(rs.map((r) => r.status)).toEqual([403, 403, 403, 403])
    expect(rpc).not.toHaveBeenCalled()
    expect(inv).not.toHaveBeenCalled()
  })
})

describe("validation before any rpc", () => {
  it("invalid uuid / unknown service / bad severity / bad dates are 400 without an rpc", async () => {
    const { rpc, c } = client()
    const inv = vi.fn()
    const rs = await Promise.all([
      setDeveloperPause(c, { userId: "nope", paused: true, reason: "Abuse seen", actorId: ADMIN }, { invalidate: inv }),
      setServicePause(c, { service: "everything", paused: true, message: null, actorId: ADMIN }, { invalidate: inv }),
      saveAnnouncement(c, ann({ severity: "urgent" })),
      saveAnnouncement(c, ann({ startsAt: "tomorrow" })),
      saveAnnouncement(c, ann({ endsAt: "2026-12-01T10:00:00Z" })),
      saveAnnouncement(c, ann({ endsAt: "2026-11-01T10:00:00Z" })),
      saveAnnouncement(c, ann({ id: "bad" })),
      deleteAnnouncement(c, { id: "bad", actorId: ADMIN }),
      setDeveloperPause(c, { userId: UID, paused: true, reason: "ab", actorId: ADMIN }, { invalidate: inv }),
    ])
    expect(rs.map((r) => r.status)).toEqual([400, 400, 400, 400, 400, 400, 400, 400, 400])
    expect(rpc).not.toHaveBeenCalled()
  })
})

describe("rpc code mapping", () => {
  it.each([
    ["not_found", 404],
    ["bad_reason", 400],
    ["bad_message", 400],
    ["bad_input", 400],
    ["too_many", 409],
  ])("%s -> %i", async (code, status) => {
    const { c } = client({ ok: false, code })
    const r = await saveAnnouncement(c, ann())
    expect(r.status).toBe(status)
    expect(r.body.ok).toBeUndefined()
  })

  it("an rpc error is a generic 500, and console.error carries only function name and code", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    const { c } = client(null, { code: "XX000", message: "secret@example.com 0244123456 detail" })
    const r = await setDeveloperPause(c, { userId: UID, paused: true, reason: "Abuse seen", actorId: ADMIN }, { invalidate: vi.fn() })
    expect(r.status).toBe(500)
    expect(JSON.stringify(r.body)).not.toMatch(/secret|0244/)
    expect(JSON.stringify(spy.mock.calls)).not.toMatch(/secret|0244|detail/)
    spy.mockRestore()
  })

  it("a thrown rpc and an unknown result shape are 500 and not success", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    const throwing = { rpc: async () => { throw new Error("boom with 0244123456") }, from() {} } as any
    expect((await deleteAnnouncement(throwing, { id: UID, actorId: ADMIN })).status).toBe(500)
    expect((await deleteAnnouncement(client({ weird: 1 }).c, { id: UID, actorId: ADMIN })).status).toBe(500)
    expect((await deleteAnnouncement(client(null).c, { id: UID, actorId: ADMIN })).status).toBe(500)
    spy.mockRestore()
  })
})

describe("controls snapshot", () => {
  it("a changed developer pause invalidates; unchanged or failed does not", async () => {
    const inv = vi.fn()
    await setDeveloperPause(client({ ok: true, changed: true }).c, { userId: UID, paused: true, reason: "Abuse seen", actorId: ADMIN }, { invalidate: inv })
    expect(inv).toHaveBeenCalledTimes(1)
    await setDeveloperPause(client({ ok: true, changed: false }).c, { userId: UID, paused: true, reason: "Abuse seen", actorId: ADMIN }, { invalidate: inv })
    await setDeveloperPause(client({ ok: false, code: "not_found" }).c, { userId: UID, paused: false, reason: "", actorId: ADMIN }, { invalidate: inv })
    expect(inv).toHaveBeenCalledTimes(1)
  })

  it("a changed service pause invalidates too; failure does not", async () => {
    const inv = vi.fn()
    await setServicePause(client({ ok: true, changed: true }).c, { service: "sms", paused: true, message: null, actorId: ADMIN }, { invalidate: inv })
    expect(inv).toHaveBeenCalledTimes(1)
    await setServicePause(client(null, { code: "X" }).c, { service: "sms", paused: true, message: null, actorId: ADMIN }, { invalidate: inv })
    expect(inv).toHaveBeenCalledTimes(1)
  })

  it("a throwing invalidate does not turn a successful write into a failure", async () => {
    const r = await setServicePause(client().c, { service: "sms", paused: true, message: null, actorId: ADMIN }, { invalidate: () => { throw new Error("x") } })
    expect(r.status).toBe(200)
  })
})

describe("service message", () => {
  const call = (message: string | null, paused = true) => {
    const k = client()
    return setServicePause(k.c, { service: "data", paused, message, actorId: ADMIN }, { invalidate: vi.fn() }).then((r) => ({ r, rpc: k.rpc }))
  }
  it("200 characters pass, 201 are refused", async () => {
    expect((await call("a".repeat(200))).r.status).toBe(200)
    const { r, rpc } = await call("a".repeat(201))
    expect(r.status).toBe(400)
    expect(rpc).not.toHaveBeenCalled()
  })
  it("control and invisible characters are refused", async () => {
    for (const bad of ["line\nbreak", "tab\there", "nul\u0000", "zero\u200Bwidth", "bidi\u202Eevil", "del\u007F", "c1\u0085"]) {
      const { r, rpc } = await call(bad)
      expect(r.status).toBe(400)
      expect(rpc).not.toHaveBeenCalled()
    }
  })
  it("HTML is passed through unmodified", async () => {
    const html = "<b>Back soon</b> & <script>x</script>"
    const { rpc } = await call(html)
    expect(rpc.mock.calls[0][1].p_message).toBe(html)
  })
  it("resuming sends no message", async () => {
    const { rpc } = await call("ignored", false)
    expect(rpc.mock.calls[0][1].p_message).toBeNull()
  })
})

describe("announcements", () => {
  it("title 80 ok / 81 refused; body 1000 ok / 1001 refused; body may hold newlines, title may not", async () => {
    expect((await saveAnnouncement(client().c, ann({ title: "t".repeat(80) }))).status).toBe(200)
    expect((await saveAnnouncement(client().c, ann({ title: "t".repeat(81) }))).status).toBe(400)
    expect((await saveAnnouncement(client().c, ann({ body: "b".repeat(1000) }))).status).toBe(200)
    expect((await saveAnnouncement(client().c, ann({ body: "b".repeat(1001) }))).status).toBe(400)
    expect((await saveAnnouncement(client().c, ann({ body: "two\nlines" }))).status).toBe(200)
    expect((await saveAnnouncement(client().c, ann({ title: "two\nlines" }))).status).toBe(400)
  })
  it("sends normalised ISO dates and the admin as actor", async () => {
    const k = client()
    await saveAnnouncement(k.c, ann({ id: UID }))
    const a = k.rpc.mock.calls[0][1]
    expect(a).toMatchObject({ p_id: UID, p_starts: "2026-12-01T10:00:00.000Z", p_ends: "2026-12-01T12:00:00.000Z", p_actor: ADMIN })
  })
  it("a failed rpc writes no audit row and returns no success", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    const r = await saveAnnouncement(client(null, { code: "XX" }).c, ann())
    expect(r.status).toBe(500)
    expect(r.body.ok).toBeUndefined()
    spy.mockRestore()
  })
})
