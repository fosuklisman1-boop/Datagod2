import { describe, it, expect, vi } from "vitest"
import { extractHubnetRef, tokenOk, processHubnetWebhook, redactHubnetBody } from "./webhook"

const mk = (kind: "DG" | "DA", n: string) => `${kind}${n.repeat(22)}`
const DG = mk("DG", "1")
const DA = mk("DA", "2")

function makeDb(tracking: any[], airtime: any[]) {
  const from = (table: string) => {
    const f: Array<[string, any]> = []
    const b: any = {
      select: () => b,
      eq: (c: string, v: any) => (f.push([c, v]), b),
      ilike: (_c: string, v: string) => (f.push(["ilike", v.replace(/%/g, "")]), b),
      limit: () => b,
      then: (res: any, rej: any) => {
        const src = table === "airtime_orders" ? airtime : tracking
        const data = src.filter((r) => f.every(([c, v]) => (c === "ilike" ? String(r.notes ?? "").includes(v) : r[c] === v)))
        return Promise.resolve({ data, error: null }).then(res, rej)
      },
    }
    return b
  }
  return { from } as any
}

const found = (status: "processing" | "completed" | "failed", refunded = false) =>
  ({ kind: "found", status, refunded, raw: {} }) as any

function setup(opts: { tracking?: any[]; airtime?: any[]; lookup?: any }) {
  const client = { getStatus: vi.fn(async () => opts.lookup ?? found("processing")) } as any
  const applyData = vi.fn(async () => true)
  const applyAirtime = vi.fn(async () => true)
  return { deps: { db: makeDb(opts.tracking ?? [], opts.airtime ?? []), client, applyData, applyAirtime }, client, applyData, applyAirtime }
}

describe("tokenOk", () => {
  const env = { HUBNET_WEBHOOK_TOKEN: "s3cret-token" } as any
  it("accepts the exact token", () => expect(tokenOk("s3cret-token", env)).toBe(true))
  it("rejects wrong, short, long, null, empty", () => {
    expect(tokenOk("s3cret-tokeX", env)).toBe(false)
    expect(tokenOk("s3cret", env)).toBe(false)
    expect(tokenOk("s3cret-token-and-more", env)).toBe(false)
    expect(tokenOk(null, env)).toBe(false)
    expect(tokenOk("", env)).toBe(false)
  })
  it("rejects when env unset or empty", () => {
    expect(tokenOk("anything", {} as any)).toBe(false)
    expect(tokenOk("", { HUBNET_WEBHOOK_TOKEN: "" } as any)).toBe(false)
  })
})

describe("extractHubnetRef", () => {
  it("reads reference, batch_id and nested data variants", () => {
    expect(extractHubnetRef({ reference: DG })).toBe(DG)
    expect(extractHubnetRef({ batch_id: DG })).toBe(DG)
    expect(extractHubnetRef({ data: { reference: DA } })).toBe(DA)
    expect(extractHubnetRef({ data: { batch_id: DA } })).toBe(DA)
  })
  it("rejects refs that do not parse and non-objects", () => {
    expect(extractHubnetRef({ reference: "nope" })).toBeNull()
    expect(extractHubnetRef(null)).toBeNull()
    expect(extractHubnetRef("x")).toBeNull()
    expect(extractHubnetRef({ reference: 5 })).toBeNull()
  })
})

describe("processHubnetWebhook", () => {
  it("ignores refs not in tracking", async () => {
    const s = setup({ tracking: [] })
    expect(await processHubnetWebhook(DG, s.deps)).toBe("ignored")
    expect(s.applyData).not.toHaveBeenCalled()
  })
  it("ignores refs not in airtime_orders", async () => {
    const s = setup({ airtime: [] })
    expect(await processHubnetWebhook(DA, s.deps)).toBe("ignored")
    expect(s.applyAirtime).not.toHaveBeenCalled()
  })
  it("uses the authenticated lookup status", async () => {
    const row = { id: "t1", mtn_order_id: DG, provider: "hubnet", status: "pending" }
    const s = setup({ tracking: [row], lookup: found("processing") })
    expect(await processHubnetWebhook(DG, s.deps)).toBe("applied")
    expect(s.client.getStatus).toHaveBeenCalledWith(DG)
    expect(s.applyData).toHaveBeenCalledWith(expect.anything(), row, "processing", expect.objectContaining({ status: expect.any(String) }))
  })
  it("maps refunded to failed", async () => {
    const row = { id: "t1", mtn_order_id: DG, provider: "hubnet", status: "processing" }
    const s = setup({ tracking: [row], lookup: found("completed", true) })
    expect(await processHubnetWebhook(DG, s.deps)).toBe("applied")
    expect(s.applyData).toHaveBeenCalledWith(expect.anything(), row, "failed", expect.anything())
  })
  it("ignores when status already equals the row status", async () => {
    const row = { id: "t1", mtn_order_id: DG, provider: "hubnet", status: "processing" }
    const s = setup({ tracking: [row], lookup: found("processing") })
    expect(await processHubnetWebhook(DG, s.deps)).toBe("ignored")
    expect(s.applyData).not.toHaveBeenCalled()
  })
  it("ignores completed rows (reversal path owns them)", async () => {
    const row = { id: "t1", mtn_order_id: DG, provider: "hubnet", status: "completed" }
    const s = setup({ tracking: [row], lookup: found("failed") })
    expect(await processHubnetWebhook(DG, s.deps)).toBe("ignored")
    expect(s.applyData).not.toHaveBeenCalled()
  })
  it("returns ignored when the guarded write lost the race", async () => {
    const row = { id: "t1", mtn_order_id: DG, provider: "hubnet", status: "pending" }
    const s = setup({ tracking: [row], lookup: found("completed") })
    s.applyData.mockResolvedValueOnce(false)
    expect(await processHubnetWebhook(DG, s.deps)).toBe("ignored")
  })
  it("missing/unknown lookups => unknown, no writes", async () => {
    for (const lookup of [{ kind: "missing" }, { kind: "unknown" }]) {
      const row = { id: "t1", mtn_order_id: DG, provider: "hubnet", status: "pending" }
      const s = setup({ tracking: [row], lookup })
      expect(await processHubnetWebhook(DG, s.deps)).toBe("unknown")
      expect(s.applyData).not.toHaveBeenCalled()
    }
  })
  it("DA ref routes to the airtime applier with the exact-bracket match", async () => {
    const good = { id: "a1", status: "processing", notes: `x [hubnetRef:${DA}]` }
    const s = setup({ airtime: [good], lookup: found("completed") })
    expect(await processHubnetWebhook(DA, s.deps)).toBe("applied")
    expect(s.applyAirtime).toHaveBeenCalledWith(expect.anything(), "a1", expect.objectContaining({ kind: "found" }))
    expect(s.applyData).not.toHaveBeenCalled()
  })
  it("airtime: a longer ref sharing the prefix (R2) does not match, non-processing ignored", async () => {
    const other = { id: "a2", status: "processing", notes: `[hubnetRef:${DA}R2]` }
    const done = { id: "a3", status: "completed", notes: `[hubnetRef:${DA}]` }
    const s = setup({ airtime: [other, done] })
    expect(await processHubnetWebhook(DA, s.deps)).toBe("ignored")
    expect(s.applyAirtime).not.toHaveBeenCalled()
  })
  it("never throws: errors become unknown", async () => {
    const row = { id: "t1", mtn_order_id: DG, provider: "hubnet", status: "pending" }
    const s = setup({ tracking: [row] })
    s.client.getStatus.mockRejectedValueOnce(new Error("boom"))
    expect(await processHubnetWebhook(DG, s.deps)).toBe("unknown")
  })
  it("invalid ref => ignored without lookups", async () => {
    const s = setup({})
    expect(await processHubnetWebhook("bad", s.deps)).toBe("ignored")
    expect(s.client.getStatus).not.toHaveBeenCalled()
  })
})

describe("redactHubnetBody", () => {
  it("masks phone numbers and truncates to 2000", () => {
    const out = redactHubnetBody(`{"p":"0241234567","q":"233241234567"}`)
    expect(out).not.toContain("0241234567")
    expect(out).not.toContain("233241234567")
    expect(redactHubnetBody("a".repeat(5000)).length).toBe(2000)
  })
})
