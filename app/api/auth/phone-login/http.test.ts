import { describe, it, expect } from "vitest"
import { withTimingFloor } from "./http"

function fakeClock(start = 1_000_000) {
  let t = start
  const slept: number[] = []
  return {
    deps: {
      now: () => t,
      sleep: async (ms: number) => {
        slept.push(ms)
        t += ms
      },
      random: () => 0.5,
    },
    advance: (ms: number) => {
      t += ms
    },
    slept,
    now: () => t,
  }
}

describe("withTimingFloor", () => {
  it("waits out the rest of the floor plus jitter when the work was fast", async () => {
    const c = fakeClock()
    const start = c.now()
    c.advance(100) // work took 100 ms
    await withTimingFloor(start, 700, 100, c.deps)
    // 700 floor + 0.5 * 100 jitter = 750 ms from start
    expect(c.now() - start).toBe(750)
    expect(c.slept).toEqual([650])
  })

  it("never sleeps when the work already took longer than floor + jitter", async () => {
    const c = fakeClock()
    const start = c.now()
    c.advance(2000)
    await withTimingFloor(start, 700, 100, c.deps)
    expect(c.slept).toEqual([])
  })

  it("jitter is within [0, jitterMs)", async () => {
    for (const [r, extra] of [[0, 0], [0.999, 99.9]] as const) {
      const c = fakeClock()
      const start = c.now()
      await withTimingFloor(start, 700, 100, { ...c.deps, random: () => r })
      expect(c.now() - start).toBeCloseTo(700 + extra, 5)
    }
  })
})
