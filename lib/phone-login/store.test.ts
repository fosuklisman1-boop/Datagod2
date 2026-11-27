import { describe, it, expect } from "vitest"
import { LIMITS } from "./core"
import {
  findAccount,
  isLocked,
  beginAttempt,
  endAttempt,
  recordFailure,
  recordEvent,
  countDistinctPhonesFromIp,
  countEvents,
  hadPasswordChangeSince,
  createChallenge,
  getChallenge,
  bumpChallengeAttempt,
  consumeChallenge,
  killChallenge,
  touchChallengeSent,
  findTrustedDevice,
  trustDevice,
  touchDevice,
} from "./store"

type Row = Record<string, unknown>
type Filter = (r: Row) => boolean

/** Stateful in-memory fake modelling the PostgREST chain subset the store uses. */
function makeDb(opts: { rpc?: Record<string, { data?: unknown; error?: unknown }>; insertError?: unknown } = {}) {
  const tables: Record<string, Row[]> = {
    phone_login_events: [],
    phone_login_challenges: [],
    trusted_devices: [],
  }
  let seq = 0
  const cmp = (a: unknown, b: unknown) => (a as string | number) > (b as string | number)

  const from = (name: string) => {
    const rows = (tables[name] ??= [])
    const filters: Filter[] = []
    let mode: "select" | "update" | "insert" = "select"
    let patch: Row = {}
    let inserted: Row | null = null
    let head = false
    let wantCount = false
    let orderBy: { col: string; asc: boolean } | null = null
    let limitN: number | null = null
    let returning = false

    const run = () => {
      if (mode === "insert") {
        if (opts.insertError) return { data: null, error: opts.insertError }
        rows.push(inserted as Row)
        return { data: null, error: null }
      }
      let matched = rows.filter((r) => filters.every((f) => f(r)))
      if (mode === "update") {
        for (const r of matched) Object.assign(r, patch)
        return { data: returning ? matched.map((r) => ({ ...r })) : null, error: null }
      }
      if (orderBy) {
        const { col, asc } = orderBy
        matched = [...matched].sort((a, b) => (a[col] === b[col] ? 0 : cmp(a[col], b[col]) === asc ? 1 : -1))
      }
      if (limitN !== null) matched = matched.slice(0, limitN)
      return {
        data: head ? null : matched.map((r) => ({ ...r })),
        count: wantCount ? matched.length : null,
        error: null,
      }
    }

    const q: Record<string, unknown> = {
      select(_cols?: string, o?: { count?: string; head?: boolean }) {
        if (mode === "update") returning = true
        if (o?.count) wantCount = true
        if (o?.head) head = true
        return q
      },
      insert(row: Row) {
        mode = "insert"
        inserted = { id: `gen-${++seq}`, revoked_at: null, consumed_at: null, ...row }
        return q
      },
      update(p: Row) {
        mode = "update"
        patch = p
        return q
      },
      eq(c: string, v: unknown) {
        filters.push((r) => r[c] === v)
        return q
      },
      is(c: string, v: unknown) {
        filters.push((r) => (r[c] ?? null) === v)
        return q
      },
      gt(c: string, v: unknown) {
        filters.push((r) => (r[c] as string) > (v as string))
        return q
      },
      gte(c: string, v: unknown) {
        filters.push((r) => (r[c] as string) >= (v as string))
        return q
      },
      in(c: string, vs: unknown[]) {
        filters.push((r) => vs.includes(r[c]))
        return q
      },
      order(col: string, o?: { ascending?: boolean }) {
        orderBy = { col, asc: o?.ascending !== false }
        return q
      },
      limit(n: number) {
        limitN = n
        return q
      },
      maybeSingle() {
        const res = run()
        const list = (res.data ?? []) as Row[]
        return Promise.resolve({ data: list[0] ?? null, error: res.error })
      },
      then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
        return Promise.resolve(run()).then(resolve, reject)
      },
    }
    return q
  }

  const rpc = async (fn: string) => {
    const r = opts.rpc?.[fn]
    return { data: r?.data ?? null, error: r?.error ?? null }
  }
  return { db: { from, rpc } as never, tables }
}

const NOW = new Date("2026-11-27T12:00:00.000Z")
const U1 = "00000000-0000-0000-0000-000000000001"
const U2 = "00000000-0000-0000-0000-000000000002"

describe("findAccount", () => {
  it("maps the RPC row to Account", async () => {
    const { db } = makeDb({
      rpc: {
        phone_login_find_account: {
          data: [
            {
              match_count: 2,
              verified_count: 1,
              user_id: U1,
              email: "a@b.c",
              phone_number: "0241234567",
              phone_verified: true,
              is_suspended: false,
            },
          ],
        },
      },
    })
    expect(await findAccount(db, "241234567")).toEqual({
      matchCount: 2,
      verifiedCount: 1,
      userId: U1,
      email: "a@b.c",
      phone: "0241234567",
      phoneVerified: true,
      isSuspended: false,
    })
  })

  it("no row gives the empty account", async () => {
    const { db } = makeDb({ rpc: { phone_login_find_account: { data: [] } } })
    expect(await findAccount(db, "x")).toEqual({
      matchCount: 0,
      verifiedCount: 0,
      userId: null,
      email: null,
      phone: null,
      phoneVerified: false,
      isSuspended: false,
    })
  })

  it("an RPC error throws", async () => {
    const { db } = makeDb({ rpc: { phone_login_find_account: { error: new Error("rpc down") } } })
    await expect(findAccount(db, "x")).rejects.toThrow("rpc down")
  })
})

describe("isLocked / recordFailure", () => {
  it("return the RPC booleans", async () => {
    const { db } = makeDb({
      rpc: { phone_login_is_locked: { data: true }, phone_login_record_failure: { data: true } },
    })
    expect(await isLocked(db, "h")).toBe(true)
    expect(await recordFailure(db, "h", "i")).toEqual({ locked: true })
  })

  it("RPC errors throw (fail closed)", async () => {
    const { db } = makeDb({
      rpc: { phone_login_is_locked: { error: new Error("x") }, phone_login_record_failure: { error: new Error("y") } },
    })
    await expect(isLocked(db, "h")).rejects.toThrow("x")
    await expect(recordFailure(db, "h", "i")).rejects.toThrow("y")
  })
})

describe("beginAttempt / endAttempt", () => {
  it("beginAttempt returns the RPC boolean (false = locked) and passes both hashes", async () => {
    const { db } = makeDb({ rpc: { phone_login_begin_attempt: { data: false } } })
    expect(await beginAttempt(db, "h", "i")).toBe(false)
    const ok = makeDb({ rpc: { phone_login_begin_attempt: { data: true } } })
    expect(await beginAttempt(ok.db, "h", "i")).toBe(true)
  })

  it("beginAttempt treats anything but true as locked (fail closed)", async () => {
    const { db } = makeDb({ rpc: { phone_login_begin_attempt: { data: null } } })
    expect(await beginAttempt(db, "h", "i")).toBe(false)
  })

  it("both THROW on an RPC error", async () => {
    const { db } = makeDb({
      rpc: { phone_login_begin_attempt: { error: new Error("b") }, phone_login_end_attempt: { error: new Error("e") } },
    })
    await expect(beginAttempt(db, "h", "i")).rejects.toThrow("b")
    await expect(endAttempt(db, "h")).rejects.toThrow("e")
  })

  it("endAttempt resolves on success", async () => {
    const { db } = makeDb({ rpc: { phone_login_end_attempt: { data: null } } })
    await expect(endAttempt(db, "h")).resolves.toBeUndefined()
  })
})

describe("events", () => {
  it("recordEvent swallows DB errors", async () => {
    const { db } = makeDb({ insertError: new Error("insert failed") })
    await expect(recordEvent(db, "fail", { phoneHash: "p" })).resolves.toBeUndefined()
  })

  it("recordEvent swallows a thrown client", async () => {
    const db = {
      from: () => {
        throw new Error("boom")
      },
    } as never
    await expect(recordEvent(db, "login_ok", { userId: U1 })).resolves.toBeUndefined()
  })

  it("recordEvent writes the row", async () => {
    const { db, tables } = makeDb()
    await recordEvent(db, "fail", { phoneHash: "p", ipHash: "i" })
    expect(tables.phone_login_events[0]).toMatchObject({ kind: "fail", phone_hash: "p", ip_hash: "i", user_id: null })
  })

  it("countDistinctPhonesFromIp counts distinct phones for fails from that ip in the window", async () => {
    const { db, tables } = makeDb()
    const recent = new Date(Date.now() - 1000).toISOString()
    const old = new Date(Date.now() - 10_000_000).toISOString()
    tables.phone_login_events.push(
      { kind: "fail", ip_hash: "ip1", phone_hash: "a", created_at: recent },
      { kind: "fail", ip_hash: "ip1", phone_hash: "a", created_at: recent },
      { kind: "fail", ip_hash: "ip1", phone_hash: "b", created_at: recent },
      { kind: "fail", ip_hash: "ip1", phone_hash: "c", created_at: old },
      { kind: "fail", ip_hash: "ip2", phone_hash: "d", created_at: recent },
      { kind: "login_ok", ip_hash: "ip1", phone_hash: "e", created_at: recent },
    )
    expect(await countDistinctPhonesFromIp(db, "ip1", 900_000)).toBe(2)
  })

  it("countEvents counts a kind in the window", async () => {
    const { db, tables } = makeDb()
    const recent = new Date(Date.now() - 1000).toISOString()
    const old = new Date(Date.now() - 10_000_000).toISOString()
    tables.phone_login_events.push(
      { kind: "lockout", created_at: recent },
      { kind: "lockout", created_at: old },
      { kind: "fail", created_at: recent },
    )
    expect(await countEvents(db, "lockout", 900_000)).toBe(1)
  })

  it("hadPasswordChangeSince is true only for that user's change after the cutoff", async () => {
    const { db, tables } = makeDb()
    const t = NOW.getTime()
    tables.phone_login_events.push(
      { kind: "password_changed", user_id: U1, created_at: new Date(t + 5000).toISOString() },
      { kind: "password_changed", user_id: U2, created_at: new Date(t - 5000).toISOString() },
    )
    expect(await hadPasswordChangeSince(db, U1, t)).toBe(true)
    expect(await hadPasswordChangeSince(db, U2, t)).toBe(false)
    expect(await hadPasswordChangeSince(db, "nobody", t)).toBe(false)
  })
})

describe("challenges", () => {
  const mk = async (db: never, id = "c1") =>
    createChallenge(db, { id, userId: U1, browserSecretHash: "bsh", otpPhone: "0241234567", now: NOW })

  it("createChallenge/getChallenge round trip with LIMITS ttl", async () => {
    const { db } = makeDb()
    await mk(db)
    const c = await getChallenge(db, "c1")
    expect(c).toEqual({
      id: "c1",
      userId: U1,
      browserSecretHash: "bsh",
      otpPhone: "0241234567",
      attempts: 0,
      lastSentAt: NOW,
      expiresAt: new Date(NOW.getTime() + LIMITS.challengeTtlMs),
      consumedAt: null,
    })
    expect(await getChallenge(db, "missing")).toBeNull()
  })

  it("consumeChallenge returns true once, then false", async () => {
    const { db } = makeDb()
    await mk(db)
    expect(await consumeChallenge(db, "c1", NOW)).toBe(true)
    expect(await consumeChallenge(db, "c1", NOW)).toBe(false)
  })

  it("two concurrent consumes: exactly one wins", async () => {
    const { db } = makeDb()
    await mk(db)
    const results = await Promise.all([consumeChallenge(db, "c1", NOW), consumeChallenge(db, "c1", NOW)])
    expect(results.filter(Boolean)).toHaveLength(1)
  })

  it("consumeChallenge is false after expiry and for unknown ids", async () => {
    const { db } = makeDb()
    await mk(db)
    const late = new Date(NOW.getTime() + LIMITS.challengeTtlMs + 1)
    expect(await consumeChallenge(db, "c1", late)).toBe(false)
    expect(await consumeChallenge(db, "nope", NOW)).toBe(false)
  })

  it("bumpChallengeAttempt returns the new attempts", async () => {
    const { db } = makeDb()
    await mk(db)
    expect(await bumpChallengeAttempt(db, "c1")).toBe(1)
    expect(await bumpChallengeAttempt(db, "c1")).toBe(2)
    expect((await getChallenge(db, "c1"))?.attempts).toBe(2)
  })

  it("killChallenge makes it unconsumable", async () => {
    const { db } = makeDb()
    await mk(db)
    await killChallenge(db, "c1")
    expect(await consumeChallenge(db, "c1", new Date(Date.now() + 1000))).toBe(false)
  })

  it("touchChallengeSent updates last_sent_at", async () => {
    const { db } = makeDb()
    await mk(db)
    const later = new Date(NOW.getTime() + 61_000)
    await touchChallengeSent(db, "c1", later)
    expect((await getChallenge(db, "c1"))?.lastSentAt).toEqual(later)
  })
})

describe("trusted devices", () => {
  const trust = (db: never, userId: string, tokenHash: string, now = NOW) =>
    trustDevice(db, { userId, tokenHash, uaLabel: "Chrome on Android", now })

  it("finds a live device for the right user only", async () => {
    const { db } = makeDb()
    await trust(db, U1, "tok1")
    expect(await findTrustedDevice(db, "tok1", U1, NOW)).not.toBeNull()
    expect(await findTrustedDevice(db, "tok1", U2, NOW)).toBeNull()
    expect(await findTrustedDevice(db, "other", U1, NOW)).toBeNull()
  })

  it("is null for a revoked device", async () => {
    const { db, tables } = makeDb()
    await trust(db, U1, "tok1")
    tables.trusted_devices[0].revoked_at = NOW.toISOString()
    expect(await findTrustedDevice(db, "tok1", U1, NOW)).toBeNull()
  })

  it("is null for an expired device, using LIMITS.deviceTtlMs", async () => {
    const { db, tables } = makeDb()
    await trust(db, U1, "tok1")
    expect(tables.trusted_devices[0].expires_at).toBe(new Date(NOW.getTime() + LIMITS.deviceTtlMs).toISOString())
    const after = new Date(NOW.getTime() + LIMITS.deviceTtlMs + 1)
    expect(await findTrustedDevice(db, "tok1", U1, after)).toBeNull()
  })

  it("with maxDevices active, trusting another revokes the oldest", async () => {
    const { db, tables } = makeDb()
    for (let i = 0; i < LIMITS.maxDevices; i++) {
      await trust(db, U1, `tok${i}`, new Date(NOW.getTime() + i * 1000))
    }
    await trust(db, U2, "other-user", NOW)
    expect(tables.trusted_devices.filter((r) => r.user_id === U1 && r.revoked_at === null)).toHaveLength(LIMITS.maxDevices)

    await trust(db, U1, "newest", new Date(NOW.getTime() + 99_000))
    const active = tables.trusted_devices.filter((r) => r.user_id === U1 && r.revoked_at === null)
    expect(active).toHaveLength(LIMITS.maxDevices)
    expect(tables.trusted_devices.find((r) => r.token_hash === "tok0")?.revoked_at).not.toBeNull()
    expect(tables.trusted_devices.find((r) => r.token_hash === "tok1")?.revoked_at).toBeNull()
    expect(tables.trusted_devices.find((r) => r.token_hash === "newest")?.revoked_at).toBeNull()
    expect(tables.trusted_devices.find((r) => r.token_hash === "other-user")?.revoked_at).toBeNull()
  })

  it("touchDevice updates last_used_at", async () => {
    const { db, tables } = makeDb()
    await trust(db, U1, "tok1")
    const later = new Date(NOW.getTime() + 5000)
    await touchDevice(db, tables.trusted_devices[0].id as string, later)
    expect(tables.trusted_devices[0].last_used_at).toBe(later.toISOString())
  })
})
