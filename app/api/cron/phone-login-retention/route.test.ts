import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest, NextResponse } from "next/server"

const h = vi.hoisted(() => ({
  authorized: true,
  calls: [] as Array<{ table: string; op: string; args: unknown[] }>,
  fail: false,
}))

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: (table: string) => ({
      delete: (opts: unknown) => {
        const rec = { table, op: "delete", args: [opts] as unknown[] }
        h.calls.push(rec)
        const q: any = {
          lt: (col: string, val: string) => {
            rec.args.push(["lt", col, val])
            return Promise.resolve(h.fail ? { count: null, error: { message: "x" } } : { count: 3, error: null })
          },
          or: (expr: string) => {
            rec.args.push(["or", expr])
            return Promise.resolve(h.fail ? { count: null, error: { message: "x" } } : { count: 2, error: null })
          },
        }
        return q
      },
    }),
  }),
}))
vi.mock("@/lib/cron-auth", () => ({
  verifyCronAuth: vi.fn(() =>
    h.authorized
      ? { authorized: true }
      : { authorized: false, errorResponse: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) },
  ),
}))

import { GET } from "./route"

const DAY = 86_400_000
beforeEach(() => {
  h.authorized = true
  h.fail = false
  h.calls.length = 0
})

describe("GET /api/cron/phone-login-retention", () => {
  it("rejects unauthorised callers and deletes nothing", async () => {
    h.authorized = false
    expect((await GET(new NextRequest("http://localhost/x"))).status).toBe(401)
    expect(h.calls).toHaveLength(0)
  })

  it("deletes each table only past its own cutoff and returns counts only", async () => {
    const before = Date.now()
    const r = await GET(new NextRequest("http://localhost/x"))
    expect(await r.json()).toEqual({
      success: true,
      data: { challenges: 3, trustedDevices: 2, events: 3 },
    })
    const by = Object.fromEntries(h.calls.map((c) => [c.table, c]))
    const ch = by["phone_login_challenges"].args[1] as [string, string, string]
    expect(ch[1]).toBe("created_at")
    expect(Date.parse(ch[2])).toBeGreaterThan(before - DAY - 5_000)
    expect(Date.parse(ch[2])).toBeLessThan(Date.now() - DAY + 5_000)
    const ev = by["phone_login_events"].args[1] as [string, string, string]
    expect(ev[1]).toBe("created_at")
    expect(Date.parse(ev[2])).toBeLessThan(Date.now() - 30 * DAY + 5_000)
    expect(Date.parse(ev[2])).toBeGreaterThan(before - 30 * DAY - 5_000)
    const td = by["trusted_devices"].args[1] as [string, string]
    expect(td[1]).toMatch(/^revoked_at\.lt\..+,expires_at\.lt\./)
    const cutoff = td[1].split(",")[0].replace("revoked_at.lt.", "")
    expect(Date.parse(cutoff)).toBeLessThan(Date.now() - 30 * DAY + 5_000)
    expect(td[1]).toContain(`expires_at.lt.${cutoff}`)
  })

  it("sets Cache-Control: no-store on 200, 500 and unauthorised responses", async () => {
    const ok = await GET(new NextRequest("http://localhost/x"))
    expect(ok.headers.get("Cache-Control")).toBe("no-store")
    h.fail = true
    const bad = await GET(new NextRequest("http://localhost/x"))
    expect(bad.headers.get("Cache-Control")).toBe("no-store")
    h.fail = false
    h.authorized = false
    const un = await GET(new NextRequest("http://localhost/x"))
    expect(un.headers.get("Cache-Control")).toBe("no-store")
  })

  it("returns a generic 500 on a database error", async () => {
    h.fail = true
    const r = await GET(new NextRequest("http://localhost/x"))
    expect(r.status).toBe(500)
    expect(await r.json()).toEqual({ success: false, error: "Internal server error" })
  })
})
