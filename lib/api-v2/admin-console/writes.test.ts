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
    expect(rs.map((r) => r.status)).toEqual([400, 404, 400, 400, 400, 400, 400, 400, 400])
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

describe("review fixes", () => {
  const ch = (n: number) => String.fromCharCode(n)
  const inv = { invalidate: vi.fn() }

  it("unknown service is 404 not_found without an rpc", async () => {
    const k = client()
    const r = await setServicePause(k.c, { service: "everything", paused: true, message: null, actorId: ADMIN }, inv)
    expect(r.status).toBe(404)
    expect(r.body.code).toBe("not_found")
    expect(k.rpc).not.toHaveBeenCalled()
  })

  it("announcement dates need an explicit timezone and a real date", async () => {
    for (const startsAt of ["2026-12-01", "2026-12-01T10:00:00", "2026-12-01 10:00", "2026-02-31T10:00:00Z", "2026-13-01T10:00:00Z"]) {
      const k = client()
      const r = await saveAnnouncement(k.c, ann({ startsAt, endsAt: "2027-01-01T00:00:00Z" }))
      expect(r.status, startsAt).toBe(400)
      expect(k.rpc).not.toHaveBeenCalled()
    }
    const k = client()
    expect((await saveAnnouncement(k.c, ann({ startsAt: "2026-12-01T10:00:00+02:00", endsAt: "2026-12-01T12:00:00Z" }))).status).toBe(200)
    expect(k.rpc.mock.calls[0][1].p_starts).toBe("2026-12-01T08:00:00.000Z")
    const k2 = client()
    expect((await saveAnnouncement(k2.c, ann({ endsAt: "2026-12-01T12:00:00-0500" }))).status).toBe(200)
  })

  const invisible = [ch(0x200b), ch(0x202e), ch(0x3164)]
  it("invisible characters refused in reason, title and body", async () => {
    for (const c of invisible) {
      const k = client()
      expect((await setDeveloperPause(k.c, { userId: UID, paused: true, reason: "abuse" + c + "seen", actorId: ADMIN }, inv)).status).toBe(400)
      expect((await saveAnnouncement(k.c, ann({ title: "ti" + c + "tle" }))).status).toBe(400)
      expect((await saveAnnouncement(k.c, ann({ body: "bo" + c + "dy" }))).status).toBe(400)
      expect(k.rpc).not.toHaveBeenCalled()
    }
  })
  it("body refuses other control characters but allows tab, LF and CR", async () => {
    const k = client()
    expect((await saveAnnouncement(k.c, ann({ body: "a" + ch(7) + "b" }))).status).toBe(400)
    expect(k.rpc).not.toHaveBeenCalled()
    expect((await saveAnnouncement(k.c, ann({ body: "a\tb\nc\r\nd" }))).status).toBe(200)
  })
  it("NBSP-only or whitespace-only title and reason are refused", async () => {
    const k = client()
    for (const t of [ch(0xa0), "   ", ch(0xa0).repeat(5), "\t"]) {
      expect((await saveAnnouncement(k.c, ann({ title: t }))).status).toBe(400)
      expect((await setDeveloperPause(k.c, { userId: UID, paused: true, reason: t + t, actorId: ADMIN }, inv)).status).toBe(400)
    }
    expect(k.rpc).not.toHaveBeenCalled()
  })
  it("type confusion is 400 with zero rpc calls", async () => {
    const k = client()
    const odd: any[] = [123, ["abc"], { a: 1 }, true]
    for (const v of odd) {
      expect((await setDeveloperPause(k.c, { userId: UID, paused: true, reason: v, actorId: ADMIN }, inv)).status).toBe(400)
      expect((await setServicePause(k.c, { service: "data", paused: true, message: v, actorId: ADMIN }, inv)).status).toBe(400)
      expect((await saveAnnouncement(k.c, ann({ title: v }))).status).toBe(400)
      expect((await saveAnnouncement(k.c, ann({ body: v }))).status).toBe(400)
    }
    for (const paused of ["yes", 1, null, undefined, [true]] as any[]) {
      expect((await setDeveloperPause(k.c, { userId: UID, paused, reason: "abuse seen", actorId: ADMIN }, inv)).status).toBe(400)
      expect((await setServicePause(k.c, { service: "data", paused, message: null, actorId: ADMIN }, inv)).status).toBe(400)
    }
    expect(k.rpc).not.toHaveBeenCalled()
  })
  it("unpause ignores the reason", async () => {
    const k = client()
    const r = await setDeveloperPause(k.c, { userId: UID, paused: false, reason: "x" + ch(0x200b), actorId: ADMIN }, inv)
    expect(r.status).toBe(200)
    expect(k.rpc.mock.calls[0][1].p_reason).toBeNull()
  })
  it("migration not applied (function missing) -> 500 Not set up yet, not the generic error (review M3)", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    for (const err of [{ code: "PGRST202", message: "Could not find the function public.api_v2_set_service_pause" }, { code: "42883", message: "function does not exist" }]) {
      const r = await setServicePause(client(null, err).c, { service: "data", paused: true, message: null, actorId: ADMIN }, inv)
      expect(r.status).toBe(500)
      expect((r.body as { code?: string }).code).toBe("not_set_up")
      expect(JSON.stringify(r.body)).not.toMatch(/public\.api_v2/)
    }
    spy.mockRestore()
  })
  it("rpc 55P03 lock timeout is a generic 500", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    const r = await setServicePause(client(null, { code: "55P03", message: "lock detail" }).c, { service: "data", paused: true, message: null, actorId: ADMIN }, inv)
    expect(r.status).toBe(500)
    expect(JSON.stringify(r.body)).not.toMatch(/lock detail/)
    spy.mockRestore()
  })
})
