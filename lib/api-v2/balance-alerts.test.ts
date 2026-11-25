import { describe, it, expect } from "vitest"
import { runBalanceAlertSweep, alertText, type AlertDeps } from "./balance-alerts"

function deps(o: { failPush?: boolean; email?: string | null } = {}) {
  const sent: string[] = []
  const d: AlertDeps = {
    contact: async () => ({ email: o.email === undefined ? "dev@example.test" : o.email, name: "Ama <b>" }),
    inApp: async (u) => void sent.push(`inapp:${u}`),
    push: async (u) => {
      if (o.failPush) throw new Error("push down")
      sent.push(`push:${u}`)
    },
    email: async (to, _s, _t, html) => void sent.push(`email:${to.email}:${html.includes("&lt;b&gt;")}`),
  }
  return { d, sent }
}
const client = (data: unknown, error: unknown = null) => ({ rpc: async () => ({ data, error }) })

describe("runBalanceAlertSweep", () => {
  it("tells each fired person on all three free channels; the email escapes their name", async () => {
    const { d, sent } = deps()
    const r = await runBalanceAlertSweep(client([{ user_id: "u1", threshold: 50, balance: 12.3 }]), new Date(), d)
    expect(r).toEqual({ fired: 1, failed: 0 })
    expect(sent.sort()).toEqual(["email:dev@example.test:true", "inapp:u1", "push:u1"])
  })
  it("one channel failing does not stop the others; no email address skips email", async () => {
    const { d, sent } = deps({ failPush: true, email: null })
    const r = await runBalanceAlertSweep(client([{ user_id: "u1", threshold: 50, balance: 1 }]), new Date(), d)
    expect(r).toEqual({ fired: 1, failed: 1 })
    expect(sent).toEqual(["inapp:u1"])
  })
  it("nothing fired sends nothing; a scan error throws (the cron reports it)", async () => {
    const { d, sent } = deps()
    expect(await runBalanceAlertSweep(client([]), new Date(), d)).toEqual({ fired: 0, failed: 0 })
    expect(sent).toEqual([])
    await expect(runBalanceAlertSweep(client(null, { message: "x" }), new Date(), d)).rejects.toThrow(/scan failed/)
  })
  it("the message states both amounts in GHS to two places", () => {
    expect(alertText({ user_id: "u", threshold: 50, balance: 12.3 }).message).toContain("GHS 12.30, below your alert level of GHS 50.00")
  })
})
