import { describe, it, expect } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"
import { cronToSchedule } from "./schedule"

const range = (step: number) => Array.from({ length: 60 / step }, (_, i) => i * step)

describe("cronToSchedule", () => {
  it("every minute", () => {
    const s = cronToSchedule("* * * * *")
    expect(s.minutes).toEqual([-1])
    expect(s.hours).toEqual([-1])
    expect(s.mdays).toEqual([-1])
    expect(s.months).toEqual([-1])
    expect(s.wdays).toEqual([-1])
    expect(s.timezone).toBe("UTC")
  })

  it.each([2, 5, 10, 30])("every %i minutes expands to the exact minute set", (n) => {
    expect(cronToSchedule(`*/${n} * * * *`).minutes).toEqual(range(n))
  })

  it("single minute each hour", () => {
    const s = cronToSchedule("7 * * * *")
    expect(s.minutes).toEqual([7])
    expect(s.hours).toEqual([-1])
  })

  it("top of every hour", () => {
    const s = cronToSchedule("0 * * * *")
    expect(s.minutes).toEqual([0])
    expect(s.hours).toEqual([-1])
  })

  it("daily at fixed times", () => {
    expect(cronToSchedule("0 0 * * *")).toMatchObject({ minutes: [0], hours: [0] })
    expect(cronToSchedule("0 6 * * *")).toMatchObject({ minutes: [0], hours: [6] })
    expect(cronToSchedule("30 3 * * *")).toMatchObject({ minutes: [30], hours: [3] })
  })

  it("rejects unsupported syntax", () => {
    expect(() => cronToSchedule("1-5 * * * *")).toThrow(/unsupported/)
    expect(() => cronToSchedule("0 0 1 * *")).toThrow(/unsupported/)
    expect(() => cronToSchedule("* * *")).toThrow(/unsupported/)
  })

  it("converts every schedule in the real vercel.json", () => {
    const cfg = JSON.parse(readFileSync(join(__dirname, "crons.json"), "utf8"))
    expect(cfg.crons.length).toBe(39)
    for (const c of cfg.crons) expect(() => cronToSchedule(c.schedule)).not.toThrow()
  })
})
