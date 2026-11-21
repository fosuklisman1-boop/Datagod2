import { describe, it, expect } from "vitest"
import { memoryCooldown, sharedCooldown } from "./cooldown"

function clock(start = 1_000_000) {
  let t = start
  return { now: () => t, advance: (ms: number) => { t += ms } }
}

function fakeDb(initial?: unknown) {
  const store: { value?: any } = initial === undefined ? {} : { value: initial }
  const calls = { reads: 0, writes: 0 }
  const db = {
    from(table: string) {
      expect(table).toBe("admin_settings")
      return {
        select: () => ({
          eq: (_c: string, key: string) => ({
            maybeSingle: async () => {
              expect(key).toBe("hubnet_rate_limited_until")
              calls.reads++
              return { data: store.value === undefined ? null : { value: store.value }, error: null }
            },
          }),
        }),
        upsert: async (row: any, opts: any) => {
          expect(opts).toEqual({ onConflict: "key" })
          calls.writes++
          store.value = row.value
          return { error: null }
        },
      }
    },
  }
  return { db, store, calls }
}

describe("memoryCooldown", () => {
  it("is open until tripped, then counts down", async () => {
    const c = clock()
    const cd = memoryCooldown(c.now)
    expect(await cd.remainingSec()).toBe(0)
    await cd.trip(60)
    expect(await cd.remainingSec()).toBe(60)
    c.advance(59_500)
    expect(await cd.remainingSec()).toBe(1)
    c.advance(600)
    expect(await cd.remainingSec()).toBe(0)
  })
  it("never shortens and caps at 300s", async () => {
    const c = clock()
    const cd = memoryCooldown(c.now)
    await cd.trip(120)
    await cd.trip(10)
    expect(await cd.remainingSec()).toBe(120)
    await cd.trip(100_000)
    expect(await cd.remainingSec()).toBe(300)
  })
})

describe("sharedCooldown", () => {
  it("trip writes the shared row; another instance sees it", async () => {
    const c = clock()
    const { db, store } = fakeDb()
    const a = sharedCooldown(() => db, c.now)
    const b = sharedCooldown(() => db, c.now)
    await a.trip(45)
    expect(typeof store.value.until).toBe("string")
    expect(await b.remainingSec()).toBe(45)
  })
  it("caches reads for a few seconds", async () => {
    const c = clock()
    const { db, calls } = fakeDb()
    const cd = sharedCooldown(() => db, c.now)
    await cd.remainingSec()
    await cd.remainingSec()
    expect(calls.reads).toBe(1)
    c.advance(3_000)
    await cd.remainingSec()
    expect(calls.reads).toBe(2)
  })
  it("caps a forged far-future value to 300s", async () => {
    const c = clock()
    const { db } = fakeDb({ until: new Date(c.now() + 30 * 86_400_000).toISOString() })
    expect(await sharedCooldown(() => db, c.now).remainingSec()).toBe(300)
  })
  it("ignores garbage and past values", async () => {
    const c = clock()
    expect(await sharedCooldown(() => fakeDb({ until: "nope" }).db, c.now).remainingSec()).toBe(0)
    expect(await sharedCooldown(() => fakeDb({ until: 5 }).db, c.now).remainingSec()).toBe(0)
    expect(await sharedCooldown(() => fakeDb({ until: new Date(c.now() - 1000).toISOString() }).db, c.now).remainingSec()).toBe(0)
  })
  it("never throws when the DB fails, and still honours a local trip", async () => {
    const c = clock()
    const broken = { from: () => { throw new Error("db down") } }
    const cd = sharedCooldown(() => broken, c.now)
    expect(await cd.remainingSec()).toBe(0)
    await cd.trip(30)
    expect(await cd.remainingSec()).toBe(30)
  })
  it("works with no DB at all", async () => {
    const c = clock()
    const cd = sharedCooldown(() => null, c.now)
    await cd.trip(20)
    expect(await cd.remainingSec()).toBe(20)
  })
})
