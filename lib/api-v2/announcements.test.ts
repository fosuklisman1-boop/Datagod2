import { describe, it, expect } from "vitest"
import { activeAnnouncements, createAnnouncementsService } from "./announcements"

const NOW = new Date("2026-11-23T12:00:00Z")
const row = (o: Record<string, unknown> = {}) => ({
  id: "a1", title: "Maintenance", body: "Short window", severity: "info",
  starts_at: "2026-11-23T10:00:00Z", ends_at: "2026-11-23T14:00:00Z", ...o,
})

describe("activeAnnouncements", () => {
  it("not started, ended, unknown severity and over-long fields are dropped", () => {
    const out = activeAnnouncements(
      [
        row({ id: "ok" }),
        row({ id: "future", starts_at: "2026-11-23T12:00:01Z" }),
        row({ id: "ended", ends_at: "2026-11-23T12:00:00Z" }),
        row({ id: "sev", severity: "fatal" }),
        row({ id: "title", title: "x".repeat(81) }),
        row({ id: "body", body: "x".repeat(1001) }),
        row({ id: "empty", title: "" }),
        null,
        "junk",
      ],
      NOW,
    )
    expect(out.map((a) => a.id)).toEqual(["ok"])
    expect(out[0]).toEqual({ id: "ok", title: "Maintenance", body: "Short window", severity: "info", endsAt: "2026-11-23T14:00:00.000Z" })
  })
  it("starts exactly now is active; newest first; max 5; non-array gives []", () => {
    const rows = Array.from({ length: 7 }, (_, i) => row({ id: `r${i}`, starts_at: new Date(NOW.getTime() - i * 60_000).toISOString() }))
    const out = activeAnnouncements(rows, NOW)
    expect(out.map((a) => a.id)).toEqual(["r0", "r1", "r2", "r3", "r4"])
    expect(activeAnnouncements({}, NOW)).toEqual([])
  })
  it("HTML in title/body is returned unchanged (rendering escapes it)", () => {
    const out = activeAnnouncements([row({ title: "<b>hi</b>", body: "<script>alert(1)</script>" })], NOW)
    expect(out[0].title).toBe("<b>hi</b>")
    expect(out[0].body).toBe("<script>alert(1)</script>")
  })
})

function fake(res: () => { data: unknown; error: unknown }) {
  let calls = 0
  const client = {
    from() {
      calls++
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chain: any = {
        select: () => chain, gt: () => chain, order: () => chain, limit: () => chain,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        then: (a: any, b: any) => Promise.resolve(res()).then(a, b),
      }
      return chain
    },
  }
  return { client, calls: () => calls }
}

describe("createAnnouncementsService", () => {
  it("caches for 60 s, serves last good on error, missing table reads as empty", async () => {
    let t = Date.parse("2026-11-23T12:00:00Z")
    let mode: "ok" | "err" | "missing" = "ok"
    const f = fake(() => (mode === "ok" ? { data: [row()], error: null } : mode === "err" ? { data: null, error: { message: "x" } } : { data: null, error: { code: "42P01" } }))
    const svc = createAnnouncementsService({ client: f.client, now: () => t })
    const first = await svc.get()
    expect(first).toHaveLength(1)
    for (let i = 0; i < 20; i++) await svc.get()
    expect(f.calls()).toBe(1)
    mode = "err"
    t += 61_000
    expect(await svc.get()).toEqual(first)
    t += 11 * 60_000
    expect(await svc.get()).toEqual([])
    mode = "missing"
    t += 61_000
    expect(await svc.get()).toEqual([])
  })
})
