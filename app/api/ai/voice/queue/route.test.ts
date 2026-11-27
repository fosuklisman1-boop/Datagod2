import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

type Op = { method: string; args: unknown[] }
const h = vi.hoisted(() => ({
  config: {} as Record<string, unknown>,
  user: null as { id: string } | null,
  queue: [] as Record<string, any>[],
  queueError: false,
  openKeyRows: [] as { nuance_key: number }[],
  openKeyError: false,
  rateAllowed: true,
  rateDegraded: false,
  rateCalls: [] as unknown[][],
  updates: [] as Record<string, unknown>[],
  casLose: false,
}))

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    auth: { getUser: async () => (h.user ? { data: { user: h.user }, error: null } : { data: { user: null }, error: { message: "bad" } }) },
    from: (table: string) => {
      const ops: Op[] = []
      const b: any = {}
      for (const m of ["select", "eq", "in", "gt", "lt", "order", "is", "update"]) {
        b[m] = (...args: unknown[]) => {
          ops.push({ method: m, args })
          if (m === "update" && table === "ai_voice_queue") h.updates.push(args[0] as Record<string, unknown>)
          return b
        }
      }
      const match = (r: Record<string, any>) => {
        const eqs = ops.filter((o) => o.method === "eq")
        const lts = ops.filter((o) => o.method === "lt")
        const ins = ops.filter((o) => o.method === "in")
        return eqs.every((o) => r[String(o.args[0])] === o.args[1]) &&
          lts.every((o) => r[String(o.args[0])] != null && Date.parse(r[String(o.args[0])]) < Date.parse(String(o.args[1]))) &&
          ins.every((o) => (o.args[1] as unknown[]).includes(r[String(o.args[0])]))
      }
      b.maybeSingle = async () => {
        if (table === "admin_settings") return { data: { value: h.config }, error: null }
        if (table === "ai_voice_queue") {
          if (h.queueError) return { data: null, error: { message: "x" } }
          const r = h.queue.find(match)
          return { data: r ? { ...r } : null, error: null }
        }
        return { data: null, error: null }
      }
      b.then = (res: (v: unknown) => unknown) => {
        let out: any = { data: null, error: null }
        if (table === "ai_voice_queue") {
          if (h.queueError) out = { data: null, error: { message: "x" } }
          else {
            const upd = ops.find((o) => o.method === "update")
            if (upd) {
              // Compare-and-set: report the rows that matched (and changed), like PostgREST's update().select().
              const hit = h.casLose ? [] : h.queue.filter(match)
              for (const r of hit) Object.assign(r, upd.args[0])
              out = { data: hit.map((r) => ({ id: r.id })), error: null }
            }
            else out = { data: h.queue.filter(match).sort((a, c) => a.created_at.localeCompare(c.created_at)).map((r) => ({ ...r })), error: null }
          }
        } else if (table === "ai_voice_calls") {
          out = h.openKeyError ? { data: null, error: { message: "x" } } : { data: h.openKeyRows, error: null }
        }
        return Promise.resolve(out).then(res)
      }
      return b
    },
  }),
}))
vi.mock("@/lib/rate-limiter", () => ({ applyRateLimit: async (...a: unknown[]) => { h.rateCalls.push(a.slice(1)); return { allowed: h.rateAllowed, remaining: 1, resetAt: 0, degraded: h.rateDegraded } } }))

import { POST } from "./route"
import { resetAIConfigCache } from "@/lib/ai-console/load-config"

const UUID = "11111111-1111-4111-8111-111111111111"
const ON = (extra: Record<string, unknown> = {}) => ({
  voice: { enabled: true, audiences: { public: true, storefront: true, dashboard: true, admin: true }, maxCallSeconds: 240, multiAccount: true, queueEnabled: true, ...extra },
})
const req = (body: unknown, headers: Record<string, string> = {}) =>
  new NextRequest("http://localhost/api/ai/voice/queue", { method: "POST", body: JSON.stringify(body), headers })
const authed = { authorization: "Bearer jwt" }
const cookie = { cookie: `dg_vdid=${"a".repeat(32)}` }
const ago = (ms: number) => new Date(Date.now() - ms).toISOString()
const ticket = (over: Record<string, unknown>) => ({
  id: UUID, status: "waiting", user_id: "u1", device_hash: null, created_at: ago(5_000), last_seen_at: ago(1_000), admitted_at: null, ...over,
})
const FULL = [{ nuance_key: 1 }, { nuance_key: 2 }, { nuance_key: 3 }]

beforeEach(() => {
  resetAIConfigCache()
  Object.assign(h, { config: ON(), user: { id: "u1" }, queue: [], queueError: false, openKeyRows: [], openKeyError: false, rateAllowed: true, rateDegraded: false, rateCalls: [], updates: [], casLose: false })
  process.env.NUANCE_DEVICE_SALT = "salt"
  process.env.NUANCE_API_KEY = "nk_one"
  process.env.NUANCE_API_KEY_2 = "nk_two"
  process.env.NUANCE_API_KEY_3 = "nk_three"
  for (let i = 4; i <= 9; i++) delete process.env[`NUANCE_API_KEY_${i}`]
})

describe("review fixes", () => {
  it("a waiting ticket older than the longest allowed wait expires even though it keeps checking in", async () => {
    h.config = ON({ queueMaxWaitMinutes: 10 })
    h.queue = [ticket({ created_at: ago(11 * 60_000), last_seen_at: ago(1_000) })]
    const res = await POST(req({ ticketId: UUID }, authed))
    expect(await res.json()).toEqual({ status: "expired" })
    expect(h.queue[0].status).toBe("expired")
  })

  it("admission lost to a racing request reports the ticket's current state instead of failing", async () => {
    h.queue = [ticket({})]
    h.casLose = true
    const res = await POST(req({ ticketId: UUID }, authed))
    expect(res.status).toBe(200)
    expect((await res.json()).status).toBe("waiting")
  })
})

describe("POST /api/ai/voice/queue", () => {
  it("bad body -> 400", async () => {
    expect((await POST(new NextRequest("http://localhost/x", { method: "POST", body: "nope" }))).status).toBe(400)
    expect((await POST(req({ ticketId: "nope" }, authed))).status).toBe(400)
    expect((await POST(req({ ticketId: UUID, action: "bogus" }, authed))).status).toBe(400)
  })

  it("no identity at all -> 404", async () => {
    h.user = null
    expect((await POST(req({ ticketId: UUID }))).status).toBe(404)
  })

  it("rate limit: bucket ai_voice_queue 40/min keyed by identity with pgFallback; limited -> 429, degraded -> 503", async () => {
    h.queue = [ticket({})]
    await POST(req({ ticketId: UUID }, authed))
    expect(h.rateCalls[0].slice(0, 3)).toEqual(["ai_voice_queue", 40, 60_000])
    expect(h.rateCalls[0][3]).toBe("u1")
    expect(h.rateCalls[0][4]).toEqual({ pgFallback: true })
    h.rateAllowed = false
    expect((await POST(req({ ticketId: UUID }, authed))).status).toBe(429)
    h.rateAllowed = true
    h.rateDegraded = true
    expect((await POST(req({ ticketId: UUID }, authed))).status).toBe(503)
  })

  it("somebody else's ticket, or an unknown one -> 404, nothing changed", async () => {
    h.queue = [ticket({ user_id: "other" })]
    expect((await POST(req({ ticketId: UUID }, authed))).status).toBe(404)
    expect((await POST(req({ ticketId: UUID, action: "leave" }, authed))).status).toBe(404)
    expect(h.queue[0].status).toBe("waiting")
    h.queue = []
    expect((await POST(req({ ticketId: UUID }, authed))).status).toBe(404)
  })

  it("a visitor is matched by device cookie hash, not by a user ticket", async () => {
    h.user = null
    h.queue = [ticket({ user_id: "u1" })]
    expect((await POST(req({ ticketId: UUID }, cookie))).status).toBe(404)
  })

  it("leave -> 204 and the ticket is left", async () => {
    h.queue = [ticket({})]
    const res = await POST(req({ ticketId: UUID, action: "leave" }, authed))
    expect(res.status).toBe(204)
    expect(h.queue[0].status).toBe("left")
  })

  it("leave on a ticket that is already over is a quiet 204", async () => {
    h.queue = [ticket({ status: "expired" })]
    expect((await POST(req({ ticketId: UUID, action: "leave" }, authed))).status).toBe(204)
    expect(h.queue[0].status).toBe("expired")
  })

  it("expired / left / used tickets answer with just their status", async () => {
    for (const status of ["expired", "left", "used"]) {
      h.queue = [ticket({ status })]
      const res = await POST(req({ ticketId: UUID }, authed))
      expect(await res.json()).toEqual({ status })
    }
  })

  it("expires a stale ticket first, so the caller hears expired", async () => {
    h.queue = [ticket({ last_seen_at: ago(25_000) })]
    expect(await (await POST(req({ ticketId: UUID }, authed))).json()).toEqual({ status: "expired" })
    h.queue = [ticket({ status: "admitted", admitted_at: ago(35_000) })]
    expect(await (await POST(req({ ticketId: UUID }, authed))).json()).toEqual({ status: "expired" })
  })

  it("every check-in refreshes last_seen_at", async () => {
    const old = ago(15_000)
    h.queue = [ticket({ last_seen_at: old })]
    h.openKeyRows = FULL
    await POST(req({ ticketId: UUID }, authed))
    expect(Date.parse(h.queue[0].last_seen_at)).toBeGreaterThan(Date.parse(old))
  })

  it("not first in line: stays waiting with its position and eta", async () => {
    h.queue = [ticket({ id: "a", user_id: "x1", created_at: ago(9_000) }), ticket({})]
    expect(await (await POST(req({ ticketId: UUID }, authed))).json()).toEqual({ status: "waiting", position: 2, etaSeconds: 180 })
    expect(h.queue[1].status).toBe("waiting")
  })

  it("first in line but every slot taken: stays waiting at position 1", async () => {
    h.queue = [ticket({})]
    h.openKeyRows = FULL
    expect(await (await POST(req({ ticketId: UUID }, authed))).json()).toEqual({ status: "waiting", position: 1, etaSeconds: 180 })
  })

  it("first in line with a free slot: admitted, position 0", async () => {
    h.queue = [ticket({})]
    h.openKeyRows = [{ nuance_key: 1 }]
    const body = await (await POST(req({ ticketId: UUID }, authed))).json()
    expect(body).toEqual({ status: "admitted", position: 0, etaSeconds: 0 })
    expect(h.queue[0].status).toBe("admitted")
    expect(h.queue[0].admitted_at).toBeTruthy()
  })

  it("one free slot is never given to two callers: an admitted ticket already holds it", async () => {
    h.queue = [ticket({ id: "a", user_id: "x1", status: "admitted", admitted_at: ago(2_000), created_at: ago(9_000) }), ticket({})]
    h.openKeyRows = [{ nuance_key: 1 }, { nuance_key: 2 }] // one of three accounts free, held by "a"
    expect(await (await POST(req({ ticketId: UUID }, authed))).json()).toMatchObject({ status: "waiting", position: 1 })
    expect(h.queue[1].status).toBe("waiting")
  })

  it("an admitted ticket keeps answering admitted while it is held", async () => {
    h.queue = [ticket({ status: "admitted", admitted_at: ago(5_000) })]
    expect(await (await POST(req({ ticketId: UUID }, authed))).json()).toEqual({ status: "admitted", position: 0, etaSeconds: 0 })
  })

  it("only account 1 counts when multiple accounts are off", async () => {
    h.config = ON({ multiAccount: false })
    h.queue = [ticket({})]
    h.openKeyRows = [{ nuance_key: 1 }]
    expect((await (await POST(req({ ticketId: UUID }, authed))).json()).status).toBe("waiting")
  })

  it("the line switched off meanwhile: the ticket expires", async () => {
    h.config = ON({ queueEnabled: false })
    h.queue = [ticket({})]
    expect(await (await POST(req({ ticketId: UUID }, authed))).json()).toEqual({ status: "expired" })
    expect(h.queue[0].status).toBe("expired")
  })

  it("an unreadable queue or slot count fails closed (503), nobody admitted", async () => {
    h.queue = [ticket({})]
    h.openKeyError = true
    expect((await POST(req({ ticketId: UUID }, authed))).status).toBe(503)
    expect(h.queue[0].status).toBe("waiting")
    h.openKeyError = false
    h.queueError = true
    expect((await POST(req({ ticketId: UUID }, authed))).status).toBe(503)
  })

  it("logs nothing that identifies the caller", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {})
    h.queueError = true
    await POST(req({ ticketId: UUID }, authed))
    for (const c of log.mock.calls) expect(JSON.stringify(c)).not.toMatch(new RegExp(`${UUID}|u1`))
    log.mockRestore()
  })
})
