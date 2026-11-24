import { describe, it, expect, vi } from "vitest"
import { runRiskSweep, riskMessage } from "./risk"

const U1 = "11111111-1111-4111-8111-111111111111"
const candidate = (o: Record<string, unknown> = {}) => ({
  user_id: U1,
  signal: "cap_hits",
  bucket: "2026-11-24T10:00:00+00:00",
  details: { refusals: 4, minutes: 60 },
  ...o,
})

/** rpc returns the scan; from("api_v2_risk_alerts").upsert(...ignoreDuplicates).select() returns the rows actually inserted. */
function client(scan: unknown, opts: { scanError?: unknown; names?: Record<string, string> } = {}) {
  const seen = new Set<string>()
  const upserts: any[] = []
  const c = {
    rpc: vi.fn(async () => ({ data: opts.scanError ? null : scan, error: opts.scanError ?? null })),
    from: vi.fn((table: string) => {
      if (table === "users") {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const chain: any = {
          select: () => chain,
          in: () => chain,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          then: (a: any, b: any) =>
            Promise.resolve({ data: Object.entries(opts.names ?? {}).map(([id, first_name]) => ({ id, first_name, last_name: "Mensah" })), error: null }).then(a, b),
        }
        return chain
      }
      return {
        upsert: (rows: any[]) => {
          upserts.push(rows)
          const fresh = rows.filter((r) => {
            const k = `${r.user_id}|${r.signal}|${r.bucket}`
            if (seen.has(k)) return false
            seen.add(k)
            return true
          })
          return { select: async () => ({ data: fresh, error: null }) }
        },
      }
    }),
  }
  return { c: c as never, rpc: c.rpc, upserts }
}

describe("runRiskSweep", () => {
  it("alerts off (scan returns []) -> no insert, no notify", async () => {
    const { c, upserts } = client([])
    const notify = vi.fn(async () => {})
    expect(await runRiskSweep(c, new Date(), notify)).toEqual({ found: 0, sent: 0 })
    expect(upserts).toHaveLength(0)
    expect(notify).not.toHaveBeenCalled()
  })
  it("two runs over the same scenario -> one notification (dedup on user, signal, bucket)", async () => {
    const { c } = client([candidate()], { names: { [U1]: "Ama" } })
    const notify = vi.fn(async () => {})
    expect(await runRiskSweep(c, new Date(), notify)).toEqual({ found: 1, sent: 1 })
    expect(await runRiskSweep(c, new Date(), notify)).toEqual({ found: 1, sent: 0 })
    expect(notify).toHaveBeenCalledTimes(1)
  })
  it("the message names the person and signal, carries the numbers and the profile link, and no phone or key", async () => {
    const { c } = client([candidate({ details: { distinct_recipients: 31, minutes: 10 }, signal: "recipient_fanout" })], { names: { [U1]: "Ama" } })
    const notify = vi.fn(async (_m: string) => {})
    await runRiskSweep(c, new Date(), notify)
    const msg = notify.mock.calls[0][0]
    expect(msg).toContain("Ama Mensah")
    expect(msg).toMatch(/many different numbers/i)
    expect(msg).toContain("31")
    expect(msg).toContain(`/admin/api-keys?tab=developers&dev=${U1}`)
    expect(msg).not.toMatch(/0\d{9}|dg2_|pfx/)
  })
  it("scan error -> no throw, nothing sent, logs only the code", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    const { c } = client(null, { scanError: { code: "57014", message: "secret detail" } })
    const notify = vi.fn(async () => {})
    await expect(runRiskSweep(c, new Date(), notify)).resolves.toEqual({ found: 0, sent: 0 })
    expect(notify).not.toHaveBeenCalled()
    expect(JSON.stringify(spy.mock.calls)).not.toContain("secret")
    spy.mockRestore()
  })
  it("junk candidates (bad signal, bad uuid) are dropped before insert", async () => {
    const { c, upserts } = client([candidate({ signal: "made_up" }), candidate({ user_id: "nope" }), candidate()])
    await runRiskSweep(c, new Date(), vi.fn(async () => {}))
    expect(upserts[0]).toHaveLength(1)
  })
  it("a notify failure never throws and still counts the alert as recorded", async () => {
    const { c } = client([candidate()])
    const out = await runRiskSweep(c, new Date(), async () => {
      throw new Error("sms down")
    })
    expect(out.found).toBe(1)
  })
})

describe("riskMessage", () => {
  it("each signal has a plain-words label", () => {
    for (const s of ["spend_spike", "new_key_big_spend", "recipient_fanout", "cap_hits", "failure_burst"]) {
      expect(riskMessage({ name: "A", userId: U1, signal: s, details: {} })).toMatch(/Datagod API alert/)
    }
  })
})
