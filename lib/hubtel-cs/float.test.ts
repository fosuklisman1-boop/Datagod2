import { describe, expect, it, vi } from "vitest"
import { checkLowBalance, pauseForFloat } from "./float"
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
