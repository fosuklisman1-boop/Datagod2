import { describe, it, expect } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"
import { buildJobSpecs, toCreatePayload, redactSecret } from "./jobs"

const HOST = "https://www.datagod.store"
const cfg = JSON.parse(readFileSync(join(__dirname, "crons.json"), "utf8"))
const specs = buildJobSpecs(cfg.crons, HOST)
const byPath = (p: string) => specs.find((s) => s.path === p)!

describe("buildJobSpecs", () => {
  it("builds one spec per real vercel.json cron, none unclassified", () => {
    expect(specs).toHaveLength(41)
    expect(new Set(specs.map((s) => s.path)).size).toBe(41)
    expect(specs.every((s) => ["A", "B", "C"].includes(s.batch))).toBe(true)
  })

  it("batch sizes match the plan (11 / 9 / 21)", () => {
    const n = (b: string) => specs.filter((s) => s.batch === b).length
    expect([n("A"), n("B"), n("C")]).toEqual([11, 9, 21])
  })

  it("uses the dg: ownership title prefix and full URL", () => {
    const s = byPath("/api/cron/sms-kyc-purge")
    expect(s.title).toBe("dg:/api/cron/sms-kyc-purge")
    expect(s.url).toBe(`${HOST}/api/cron/sms-kyc-purge`)
    expect(s.batch).toBe("A")
    expect(s.fulfillment).toBe(false)
  })

  it("puts provider status syncs and money jobs in fulfillment batch C", () => {
    for (const p of [
      "/api/cron/drain-fulfillment-queue",
      "/api/cron/verify-pending-payments",
      "/api/cron/withdrawals-status-check",
      "/api/cron/reconcile-paystack-refunds",
      "/api/cron/sync-mtn-status/xpress",
      "/api/cron/sync-afa-status/apexprime",
      "/api/cron/sync-codecraft-status",
      "/api/cron/hubtel-callbacks",
    ]) {
      expect(byPath(p).batch).toBe("C")
      expect(byPath(p).fulfillment).toBe(true)
    }
  })

  it("throws on an unclassified path so nothing is silently skipped", () => {
    expect(() => buildJobSpecs([{ path: "/api/cron/brand-new", schedule: "* * * * *" }], HOST)).toThrow(/unclassified/)
  })
})

describe("toCreatePayload", () => {
  it("creates disabled GET jobs with the Bearer header", () => {
    const p = toCreatePayload(byPath("/api/cron/drain-fulfillment-queue"), "test-secret") as any
    expect(p.job.enabled).toBe(false)
    expect(p.job.requestMethod).toBe(0)
    expect(p.job.url).toBe(`${HOST}/api/cron/drain-fulfillment-queue`)
    expect(p.job.extendedData.headers).toEqual({ Authorization: "Bearer test-secret" })
    expect(p.job.schedule).toMatchObject({ timezone: "UTC", expiresAt: 0, minutes: [-1] })
  })

  it("turns on failure notification only for fulfillment-class jobs", () => {
    const money = toCreatePayload(byPath("/api/cron/drain-fulfillment-queue"), "s") as any
    const plain = toCreatePayload(byPath("/api/cron/sms-kyc-purge"), "s") as any
    expect(money.job.notification).toMatchObject({ onFailure: true, onFailureCount: 3 })
    expect(plain.job.notification).toBeUndefined()
  })
})

describe("redactSecret", () => {
  it("removes every occurrence of the secret", () => {
    const out = redactSecret("Bearer abc123 and abc123 again", "abc123")
    expect(out).not.toContain("abc123")
  })
  it("is a no-op for an empty secret", () => {
    expect(redactSecret("hello", "")).toBe("hello")
  })
})
