import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

const fakeDb = vi.hoisted(() => ({
  tracking: null as null | { id: string; recipient_phone: string; created_at: string; size_gb: number },
  siblingCount: 0,
}))

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from: () => ({
      select: () => {
        const b: any = {
          eq: () => b,
          neq: () => b,
          gte: () => b,
          lte: () => Promise.resolve({ count: fakeDb.siblingCount }),
          maybeSingle: () => Promise.resolve({ data: fakeDb.tracking }),
        }
        return b
      },
    }),
  },
}))

import {
  resolveBatchOutcomes,
  resolveStatusFromAgp,
  fetchAllItemsForOrder,
} from "@/lib/mtn-providers/agentportalgh-provider"

const X = "aaaaaaaa-0000-4000-8000-00000000000a"
const Y = "bbbbbbbb-0000-4000-8000-00000000000b"
const PH = "0598842760"

const up = (ref: string, mb = 1024, at = "2026-11-16T10:00:00Z") => ({ msisdn: PH, data_mb: mb, status: "uploaded", reference: ref, created_at: at })
const term = (status: string, at: string, extra: Record<string, unknown> = {}) =>
  ({ msisdn: PH, data_mb: 1024, status, reference: null, failed_reason: null, created_at: at, ...extra })

describe("resolveBatchOutcomes — fix round 1", () => {
  it("(1) X retried (failed, failed, failed) while Y still in flight => 3 rows != 2 refs => no entry for either", () => {
    const out = resolveBatchOutcomes([
      up(X), up(Y),
      term("failed", "2026-11-16T10:01:00Z"), term("failed", "2026-11-16T10:02:00Z"), term("failed", "2026-11-16T10:03:00Z"),
    ])
    expect(out.has(X)).toBe(false)
    expect(out.has(Y)).toBe(false)
  })

  it("(1) two refs, two failed rows: cannot tell retry-of-one from one-each => never declared failed", () => {
    const out = resolveBatchOutcomes([up(X), up(Y), term("failed", "2026-11-16T10:01:00Z"), term("failed", "2026-11-16T10:02:00Z")])
    expect(out.has(X)).toBe(false)
    expect(out.has(Y)).toBe(false)
  })

  it("(1) X=[success], Y=[success] => both completed", () => {
    const out = resolveBatchOutcomes([up(X), up(Y), term("success", "2026-11-16T10:01:00Z"), term("success", "2026-11-16T10:02:00Z")])
    expect(out.get(X)?.status).toBe("completed")
    expect(out.get(Y)?.status).toBe("completed")
  })

  it("(1) more terminal rows than refs => no entry", () => {
    const out = resolveBatchOutcomes([
      up(X), up(Y),
      term("failed", "2026-11-16T10:01:00Z"), term("failed", "2026-11-16T10:02:00Z"), term("failed", "2026-11-16T10:03:00Z"),
    ])
    expect(out.size).toBe(0)
  })

  it("(2) ignores superseded terminal rows (replaced_at / replaced_by_batch_id)", () => {
    const a = resolveBatchOutcomes([up(X), term("success", "2026-11-16T10:01:00Z", { replaced_at: "2026-11-16T10:05:00Z" })])
    expect(a.has(X)).toBe(false)
    const b = resolveBatchOutcomes([up(X), term("success", "2026-11-16T10:01:00Z", { replaced_by_batch_id: "b2" })])
    expect(b.has(X)).toBe(false)
    const c = resolveBatchOutcomes([
      up(X),
      term("failed", "2026-11-16T10:01:00Z", { replaced_at: "2026-11-16T10:05:00Z" }),
      term("success", "2026-11-16T10:06:00Z"),
    ])
    expect(c.get(X)?.status).toBe("completed")
  })

  it("(3) a reference-bearing row that is itself terminal resolves by its own status", () => {
    const out = resolveBatchOutcomes([{ msisdn: PH, data_mb: 1024, status: "success", reference: X, created_at: "2026-11-16T10:01:00Z" }])
    expect(out.get(X)?.status).toBe("completed")
    const f = resolveBatchOutcomes([{ msisdn: PH, data_mb: 1024, status: "failed", failed_reason: "no", reference: X, created_at: "2026-11-16T10:01:00Z" }])
    expect(f.get(X)).toMatchObject({ status: "failed", failedReason: "no" })
  })

  it("(6) identical newest created_at with different statuses => no entry", () => {
    const out = resolveBatchOutcomes([up(X), term("failed", "2026-11-16T10:01:00Z"), term("success", "2026-11-16T10:01:00Z")])
    expect(out.has(X)).toBe(false)
  })

  it("(6) a success that was refunded is not an outcome", () => {
    const out = resolveBatchOutcomes([up(X), term("success", "2026-11-16T10:01:00Z", { refunded_at: "2026-11-16T10:09:00Z" })])
    expect(out.has(X)).toBe(false)
  })
})

// ── Poller / fetch completeness ────────────────────────────────────────────
let route: (url: string) => any

beforeEach(() => {
  fakeDb.tracking = { id: "t1", recipient_phone: PH, created_at: "2026-11-16T09:00:00Z", size_gb: 1 }
  fakeDb.siblingCount = 0
  vi.stubGlobal("fetch", vi.fn(async (input: any) => {
    const body = route(String(input))
    if (body && body.__status) return { ok: false, status: body.__status, text: async () => "err", json: async () => ({}) }
    return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body }
  }))
  vi.spyOn(console, "warn").mockImplementation(() => {})
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("resolveStatusFromAgp — fix round 1", () => {
  it("(2) the newest batch containing our ref decides, even when older batch has an outcome", async () => {
    route = (url: string) => {
      if (url.includes("/b-new/items")) return { data: [up(X, 1024, "2026-11-16T11:00:00Z")], total: 1 }
      if (url.includes("/b-old/items")) return { data: [up(X), term("success", "2026-11-16T10:01:00Z")], total: 2 }
      return { data: [
        { id: "b-old", created_at: "2026-11-16T10:00:00Z" },
        { id: "b-new", created_at: "2026-11-16T11:00:00Z" },
      ] }
    }
    const res = await resolveStatusFromAgp(X, PH, 1, "2026-11-16")
    expect(res.status).toBe("processing")
    expect(res.message).toBe("Order in AgentPortalGH batch, awaiting outcome")
  })

  it("(5) an incomplete item list (page failure) resolves nothing", async () => {
    route = (url: string) => {
      if (url.includes("/items?page=2")) return { __status: 500 }
      if (url.includes("/items")) return { data: [up(X), term("success", "2026-11-16T10:01:00Z"), ...Array.from({ length: 18 },() => term("success", "2026-11-16T10:01:00Z", { msisdn: "0241111111" }))], total: 30 }
      return { data: [{ id: "b1", created_at: "2026-11-16T10:00:00Z" }] }
    }
    fakeDb.siblingCount = 0
    const res = await resolveStatusFromAgp(X, PH, 1, "2026-11-16")
    expect(res.status).toBe("processing")
  })

  it("(5) hitting the page cap before total is incomplete", async () => {
    route = (url: string) => {
      if (url.includes("/items")) return { data: Array.from({ length: 20 }, () => term("success", "2026-11-16T10:01:00Z", { msisdn: "0241111111" })), total: 500 }
      return { data: [{ id: "b1", created_at: "2026-11-16T10:00:00Z" }] }
    }
    const r = await fetchAllItemsForOrder("b1")
    expect(r.complete).toBe(false)
    expect(r.items.length).toBe(100)
  })

  it("(5) a fully fetched list is complete", async () => {
    route = () => ({ data: [up(X), term("success", "2026-11-16T10:01:00Z")], total: 2 })
    const r = await fetchAllItemsForOrder("b1")
    expect(r.complete).toBe(true)
    expect(r.items.length).toBe(2)
  })
})
