import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

// checkOrderStatus reads our tracking row from Supabase; fake just enough of it.
const fakeDb = vi.hoisted(() => ({
  tracking: null as null | { id: string; recipient_phone: string; created_at: string; size_gb: number },
  siblingCount: 0,
}))

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from: () => ({
      select: (_cols: string, opts?: { head?: boolean }) => {
        const b: any = {
          eq: () => b,
          neq: () => b,
          gte: () => b,
          lte: () => Promise.resolve({ count: fakeDb.siblingCount }),
          maybeSingle: () => Promise.resolve({ data: fakeDb.tracking }),
        }
        void opts
        return b
      },
    }),
  },
}))

import {
  resolveBatchOutcomes,
  AgentPortalGHProvider,
  resolveStatusFromAgp,
} from "@/lib/mtn-providers/agentportalgh-provider"

const REF1 = "7e500f1b-0000-4000-8000-000000000001"
const REF2 = "7e500f1b-0000-4000-8000-000000000002"

function uploaded(ref: string, msisdn: string, mb = 1024, created = "2026-11-16T10:00:00Z") {
  return { msisdn, data_mb: mb, status: "uploaded", reference: ref, created_at: created }
}
function terminal(msisdn: string, status: string, mb = 1024, created = "2026-11-16T10:01:00Z", reason: string | null = null) {
  return { msisdn, data_mb: mb, status, reference: null, failed_reason: reason, created_at: created }
}

describe("resolveBatchOutcomes", () => {
  it("pairs an uploaded row with its success terminal row (real AGP shape)", () => {
    const out = resolveBatchOutcomes([uploaded(REF1, "0598842760"), terminal("0598842760", "success")])
    expect(out.get(REF1)).toMatchObject({ status: "completed", externalStatus: "success", failedReason: null })
  })

  it("maps a failed terminal row with its failed_reason", () => {
    const out = resolveBatchOutcomes([
      uploaded(REF1, "0598842760"),
      terminal("0598842760", "failed", 1024, "2026-11-16T10:01:00Z", "Not whitelisted"),
    ])
    expect(out.get(REF1)).toMatchObject({ status: "failed", externalStatus: "failed", failedReason: "Not whitelisted" })
  })

  it("has no entry when only the uploaded row exists", () => {
    expect(resolveBatchOutcomes([uploaded(REF1, "0598842760")]).has(REF1)).toBe(false)
  })

  it("gives both references the outcome when two same-number orders both succeeded", () => {
    const out = resolveBatchOutcomes([
      uploaded(REF1, "0598842760"),
      uploaded(REF2, "0598842760"),
      terminal("0598842760", "success"),
      terminal("0598842760", "success", 1024, "2026-11-16T10:02:00Z"),
    ])
    expect(out.get(REF1)?.status).toBe("completed")
    expect(out.get(REF2)?.status).toBe("completed")
  })

  it("refuses both references when same-number outcomes are mixed", () => {
    const out = resolveBatchOutcomes([
      uploaded(REF1, "0598842760"),
      uploaded(REF2, "0598842760"),
      terminal("0598842760", "success"),
      terminal("0598842760", "failed", 1024, "2026-11-16T10:02:00Z", "x"),
    ])
    expect(out.has(REF1)).toBe(false)
    expect(out.has(REF2)).toBe(false)
  })

  it("refuses when two same-number references have only one terminal row between them", () => {
    const out = resolveBatchOutcomes([
      uploaded(REF1, "0598842760"),
      uploaded(REF2, "0598842760"),
      terminal("0598842760", "success"),
    ])
    expect(out.has(REF1)).toBe(false)
    expect(out.has(REF2)).toBe(false)
  })

  it("does not pair rows of different data_mb", () => {
    const out = resolveBatchOutcomes([uploaded(REF1, "0598842760", 1024), terminal("0598842760", "success", 2048)])
    expect(out.has(REF1)).toBe(false)
  })

  it("pairs same-number references of different sizes independently", () => {
    const out = resolveBatchOutcomes([
      uploaded(REF1, "0598842760", 1024),
      uploaded(REF2, "0598842760", 2048),
      terminal("0598842760", "success", 1024),
      terminal("0598842760", "failed", 2048, "2026-11-16T10:01:00Z", "x"),
    ])
    expect(out.get(REF1)?.status).toBe("completed")
    expect(out.get(REF2)?.status).toBe("failed")
  })

  it("takes the newest terminal row when several match", () => {
    const out = resolveBatchOutcomes([
      uploaded(REF1, "0598842760"),
      terminal("0598842760", "failed", 1024, "2026-11-16T10:01:00Z", "first try"),
      terminal("0598842760", "success", 1024, "2026-11-16T10:09:00Z"),
    ])
    expect(out.get(REF1)?.status).toBe("completed")
  })

  it("treats a non-terminal newest row as still in flight", () => {
    const out = resolveBatchOutcomes([
      uploaded(REF1, "0598842760"),
      terminal("0598842760", "failed", 1024, "2026-11-16T10:01:00Z", "first"),
      terminal("0598842760", "processing", 1024, "2026-11-16T10:09:00Z"),
    ])
    expect(out.has(REF1)).toBe(false)
  })

  it("pairs across msisdn formats (0598842760 vs 233598842760)", () => {
    const out = resolveBatchOutcomes([uploaded(REF1, "0598842760"), terminal("233598842760", "success")])
    expect(out.get(REF1)?.status).toBe("completed")
  })

  it("ignores terminal rows of other numbers", () => {
    const out = resolveBatchOutcomes([uploaded(REF1, "0598842760"), terminal("0241234567", "success")])
    expect(out.has(REF1)).toBe(false)
  })
})

// ── Poller ────────────────────────────────────────────────────────────────
type Route = (url: string) => any
let route: Route

beforeEach(() => {
  fakeDb.tracking = { id: "t1", recipient_phone: "0598842760", created_at: "2026-11-16T09:00:00Z", size_gb: 1 }
  fakeDb.siblingCount = 0
  vi.stubGlobal("fetch", vi.fn(async (input: any) => {
    const body = route(String(input))
    return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body }
  }))
  vi.spyOn(console, "warn").mockImplementation(() => {})
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const orderList = { data: [{ id: "agp-batch-1", processing_status: "DONE", created_at: "2026-11-16T10:00:00Z" }] }
function itemsRoute(items: any[]): Route {
  return (url: string) => {
    if (url.includes("/items")) return { data: items, total: items.length }
    return orderList
  }
}

describe("AgentPortalGHProvider.checkOrderStatus (batched)", () => {
  it("returns completed from the batch even when an ambiguous sibling tracking row exists", async () => {
    fakeDb.siblingCount = 1
    route = itemsRoute([uploaded(REF1, "0598842760"), terminal("0598842760", "success")])
    const res = await new AgentPortalGHProvider().checkOrderStatus(REF1)
    expect(res.status).toBe("completed")
  })

  it("returns failed with the failure reason", async () => {
    route = itemsRoute([uploaded(REF1, "0598842760"), terminal("0598842760", "failed", 1024, "2026-11-16T10:01:00Z", "boom")])
    const res = await new AgentPortalGHProvider().checkOrderStatus(REF1)
    expect(res.status).toBe("failed")
    expect(res.message).toBe("boom")
  })

  it("returns processing with the awaiting-outcome message when only the uploaded row exists", async () => {
    route = itemsRoute([uploaded(REF1, "0598842760")])
    const res = await new AgentPortalGHProvider().checkOrderStatus(REF1)
    expect(res.status).toBe("processing")
    expect(res.message).toBe("Order in AgentPortalGH batch, awaiting outcome")
  })

  it("stays processing (never guesses) when two same-number orders have mixed outcomes", async () => {
    route = itemsRoute([
      uploaded(REF1, "0598842760"),
      uploaded(REF2, "0598842760"),
      terminal("0598842760", "success"),
      terminal("0598842760", "failed", 1024, "2026-11-16T10:02:00Z", "x"),
    ])
    const res = await new AgentPortalGHProvider().checkOrderStatus(REF1)
    expect(res.status).toBe("processing")
  })

  it("falls through to the existing phone+size logic when no batch holds our reference", async () => {
    // Another customer's reference in the batch; terminal row without reference for our phone.
    route = itemsRoute([terminal("0598842760", "success")])
    const res = await new AgentPortalGHProvider().checkOrderStatus(REF1)
    expect(res.status).toBe("completed") // legacy phone+size match, no ambiguous sibling

    fakeDb.siblingCount = 1
    const res2 = await new AgentPortalGHProvider().checkOrderStatus(REF1)
    expect(res2.status).toBe("processing") // legacy guard unchanged
  })
})

describe("resolveStatusFromAgp (no Supabase)", () => {
  it("resolves a batched order from phone + size + date", async () => {
    route = itemsRoute([uploaded(REF1, "0598842760"), terminal("0598842760", "success")])
    const res = await resolveStatusFromAgp(REF1, "0598842760", 1, "2026-11-16")
    expect(res.status).toBe("completed")
  })
})
