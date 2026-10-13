import { describe, expect, it, vi } from "vitest"
import { checkLowBalance, pauseForFloat } from "./float"
import { sendFloatAlert } from "./float-alert"
import { shouldSendAlert } from "./float-alert"

describe("pauseForFloat", () => {
  it("pauses the service and alerts admins, mentioning the shared SMS float", async () => {
    const setPaused = vi.fn(async () => {})
    const alert = vi.fn(async () => {})
    await pauseForFloat({ setPaused, alert }, "Hubtel returned 4075")
    expect(setPaused).toHaveBeenCalledWith("Hubtel returned 4075")
    expect(alert).toHaveBeenCalledTimes(1)
    const [kind, subject, message] = alert.mock.calls[0] as unknown as [string, string, string]
    expect(kind).toBe("paused")
    expect(subject).toMatch(/paused/i)
    expect(message).toMatch(/SMS/)
  })
  it("still alerts when setting the pause throws", async () => {
    const alert = vi.fn(async () => {})
    await pauseForFloat({ setPaused: async () => { throw new Error("db") }, alert }, "x")
    expect(alert).toHaveBeenCalledTimes(1)
  })
})

describe("checkLowBalance", () => {
  const mk = (balance: any, threshold: number | null = 100) => {
    const alert = vi.fn(async () => {})
    return { alert, run: () => checkLowBalance({ threshold, fetchBalance: async () => balance, alert }) }
  }
  it("does nothing when no threshold is configured", async () => {
    const { run, alert } = mk({ ok: true, amountGhs: 1 }, null)
    expect(await run()).toEqual({ checked: false })
    expect(alert).not.toHaveBeenCalled()
  })
  it("alerts when the balance is below the threshold", async () => {
    const { run, alert } = mk({ ok: true, amountGhs: 40.5 })
    expect(await run()).toEqual({ checked: true, low: true, balance: 40.5 })
    expect(alert).toHaveBeenCalledTimes(1)
    expect((alert.mock.calls[0] as unknown as string[])[0]).toBe("low_balance")
  })
  it("stays quiet at or above the threshold", async () => {
    const { run, alert } = mk({ ok: true, amountGhs: 100 })
    expect(await run()).toEqual({ checked: true, low: false, balance: 100 })
    expect(alert).not.toHaveBeenCalled()
  })
  it("a balance fetch error is reported without alerting", async () => {
    const { run, alert } = mk({ ok: false, error: "relay/hubtel 501" })
    expect(await run()).toEqual({ checked: false, error: "relay/hubtel 501" })
    expect(alert).not.toHaveBeenCalled()
  })
})

describe("shouldSendAlert (1h debounce)", () => {
  const now = new Date("2026-10-13T12:00:00.000Z")
  it("sends when never sent or invalid", () => {
    expect(shouldSendAlert(null, now)).toBe(true)
    expect(shouldSendAlert(undefined, now)).toBe(true)
    expect(shouldSendAlert("garbage", now)).toBe(true)
  })
  it("suppresses within an hour, sends after", () => {
    expect(shouldSendAlert("2026-10-13T11:30:00.000Z", now)).toBe(false)
    expect(shouldSendAlert("2026-10-13T10:59:59.000Z", now)).toBe(true)
  })
})

describe("pauseForFloat force flag", () => {
  const mk = (wasPaused?: () => Promise<boolean>) => {
    const alert = vi.fn(async () => {})
    return { alert, run: () => pauseForFloat({ setPaused: async () => {}, alert, wasPaused }, "r") }
  }
  it("forces the alert when transitioning from not-paused", async () => {
    const { alert, run } = mk(async () => false); await run()
    expect((alert.mock.calls[0] as any)[3]).toEqual({ force: true })
  })
  it("does not force when already paused", async () => {
    const { alert, run } = mk(async () => true); await run()
    expect((alert.mock.calls[0] as any)[3]).toEqual({ force: false })
  })
  it("forces when the prior state is unknown", async () => {
    const { alert, run } = mk(async () => { throw new Error("x") }); await run()
    expect((alert.mock.calls[0] as any)[3]).toEqual({ force: true })
  })
})

function fakeDb(initial: any) {
  const state: { value: any; upserts: any[]; deleted: number } = { value: initial, upserts: [], deleted: 0 }
  const db: any = {
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: state.value ? { value: state.value } : null }) }) }),
      upsert: async (row: any) => { state.upserts.push(row); state.value = row.value; return { error: null } },
      delete: () => ({ eq: async () => { state.deleted++; state.value = null; return { error: null } } }),
    }),
  }
  return { db, state }
}
const NOW = new Date("2026-10-13T12:00:00.000Z")

describe("sendFloatAlert", () => {
  it("keeps the stamp when at least one channel delivers", async () => {
    const { db, state } = fakeDb(null)
    await sendFloatAlert(db, "paused", "s", "m", { now: () => NOW, senders: { sms: async () => { throw new Error("x") }, email: async () => {} } })
    expect(state.value).toEqual({ timestamp: NOW.toISOString() })
  })
  it("restores a previous stamp when both channels fail", async () => {
    const prev = { timestamp: "2026-10-13T10:00:00.000Z" }
    const { db, state } = fakeDb(prev)
    await sendFloatAlert(db, "paused", "s", "m", { now: () => NOW, senders: { sms: async () => { throw new Error("x") }, email: async () => { throw new Error("y") } } })
    expect(state.value).toEqual(prev)
  })
  it("clears the stamp when both fail and there was none", async () => {
    const { db, state } = fakeDb(null)
    await sendFloatAlert(db, "paused", "s", "m", { now: () => NOW, senders: { sms: async () => { throw new Error("x") }, email: async () => { throw new Error("y") } } })
    expect(state.value).toBeNull()
    expect(state.deleted).toBe(1)
  })
  it("debounces within the hour but force bypasses it", async () => {
    const recent = { timestamp: "2026-10-13T11:30:00.000Z" }
    const sms = vi.fn(async () => {})
    const a = fakeDb(recent)
    await sendFloatAlert(a.db, "paused", "s", "m", { now: () => NOW, senders: { sms, email: async () => {} } })
    expect(sms).not.toHaveBeenCalled()
    const b = fakeDb(recent)
    await sendFloatAlert(b.db, "paused", "s", "m", { force: true, now: () => NOW, senders: { sms, email: async () => {} } })
    expect(sms).toHaveBeenCalledTimes(1)
  })
  it("HTML-escapes subject and message in the email", async () => {
    const { db } = fakeDb(null)
    const email = vi.fn(async (_s: string, _h: string) => {})
    await sendFloatAlert(db, "paused", "<b>s</b>", "x <script>&", { now: () => NOW, senders: { sms: async () => {}, email } })
    const html = email.mock.calls[0][1]
    expect(html).not.toContain("<script>")
    expect(html).toContain("&lt;script&gt;&amp;")
    expect(html).toContain("&lt;b&gt;s&lt;/b&gt;")
  })
  it("never throws even when the db throws", async () => {
    const db: any = { from: () => { throw new Error("db") } }
    await expect(sendFloatAlert(db, "paused", "s", "m")).resolves.toBeUndefined()
  })
})
