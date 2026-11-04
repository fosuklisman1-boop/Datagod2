import { describe, it, expect, vi } from "vitest"
import { listDueHubtelPayments, runHubtelPaymentsSweep, sendSweepAlert, SWEEP_LIMIT, type DueRow, type SweepDeps } from "./sweep"
import { confirmHubtelPayment, type HubtelPaymentRow, type HubtelPaymentStore } from "./confirm"

const NOW = new Date("2026-11-04T10:00:00.000Z")
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString()
const MIN = 60_000
const ref = (n: number) => n.toString(16).padStart(32, "0")

interface Row { reference: string; status: string; created_at: string; claimed_at: string | null; updated_at?: string; refused_at?: string | null }

/**
 * Tiny PostgREST emulator over an in-memory table: supports the chain the sweep uses
 * (from/select/eq/lt/order/limit) and actually applies it, so eligibility is tested end to end.
 * Only the selected columns come back, so a column missing from select() shows up as undefined, as in production.
 * updated_at defaults to created_at, like a freshly inserted row.
 */
function fakeDb(rows: Row[], opts: { error?: string } = {}) {
  const calls: string[] = []
  for (const r of rows) r.updated_at ??= r.created_at
  const db = {
    from(table: string) {
      calls.push(`from:${table}`)
      const filters: ((r: Row) => boolean)[] = []
      let orderCol: keyof Row | null = null
      let asc = true
      let lim = Infinity
      let selected: string[] = []
      const q: any = {
        select(cols: string) { calls.push(`select:${cols}`); selected = cols.split(",").map((c) => c.trim()); return q },
        eq(col: keyof Row, v: string) { calls.push(`eq:${String(col)}=${v}`); filters.push((r) => r[col] === v); return q },
        lt(col: keyof Row, v: string) {
          calls.push(`lt:${String(col)}<${v}`)
          // Postgres semantics: NULL < x is not true.
          filters.push((r) => r[col] !== null && new Date(r[col] as string).getTime() < new Date(v).getTime())
          return q
        },
        gt(col: keyof Row, v: string) {
          calls.push(`gt:${String(col)}>${v}`)
          filters.push((r) => r[col] !== null && new Date(r[col] as string).getTime() > new Date(v).getTime())
          return q
        },
        is(col: keyof Row, v: null) {
          calls.push(`is:${String(col)}=${v}`)
          // A row built without the column reads as NULL, as a freshly inserted row does.
          filters.push((r) => (r[col] ?? null) === v)
          return q
        },
        order(col: keyof Row, o: { ascending: boolean }) { orderCol = col; asc = o.ascending; return q },
        limit(n: number) { lim = n; return q },
        then(resolve: (v: unknown) => void, reject: (e: unknown) => void) {
          if (opts.error) return Promise.resolve({ data: null, error: { message: opts.error } }).then(resolve, reject)
          let out = rows.filter((r) => filters.every((f) => f(r)))
          if (orderCol) {
            const c = orderCol
            out = [...out].sort((a, b) => String(a[c]).localeCompare(String(b[c])) * (asc ? 1 : -1))
          }
          const project = (r: Row) => Object.fromEntries(selected.map((c) => [c, r[c as keyof Row]]))
          return Promise.resolve({ data: out.slice(0, lim).map(project), error: null }).then(resolve, reject)
        },
      }
      return q
    },
  }
  return { db, calls }
}

describe("listDueHubtelPayments", () => {
  it("picks pending older than 5 min and confirming claimed more than 10 min ago; boundaries excluded", async () => {
    const rows: Row[] = [
      { reference: ref(1), status: "pending", created_at: ago(5 * MIN + 1), claimed_at: null }, // due
      { reference: ref(2), status: "pending", created_at: ago(5 * MIN), claimed_at: null }, // exactly 5 min: not yet
      { reference: ref(3), status: "pending", created_at: ago(4 * MIN), claimed_at: null }, // too fresh
      { reference: ref(4), status: "confirming", created_at: ago(60 * MIN), claimed_at: ago(10 * MIN + 1) }, // due
      { reference: ref(5), status: "confirming", created_at: ago(60 * MIN), claimed_at: ago(10 * MIN) }, // exactly 10: not yet
      { reference: ref(6), status: "confirming", created_at: ago(60 * MIN), claimed_at: ago(2 * MIN) }, // held
      { reference: ref(7), status: "confirming", created_at: ago(60 * MIN), claimed_at: null }, // no claim stamp
      { reference: ref(8), status: "paid", created_at: ago(60 * MIN), claimed_at: ago(30 * MIN) },
      { reference: ref(10), status: "needs_review", created_at: ago(60 * MIN), claimed_at: ago(30 * MIN) },
    ]
    const { db, calls } = fakeDb(rows)
    const due = await listDueHubtelPayments(db as any, NOW)
    expect(due.map((r) => r.reference)).toEqual([ref(4), ref(1)]) // least recently checked first
    expect(calls.filter((c) => c.startsWith("from:")).every((c) => c === "from:hubtel_payments")).toBe(true)
    // A pending row 5 min old must not be confirming-filtered by claimed_at, and vice versa.
    expect(calls).toContain(`lt:created_at<${ago(5 * MIN)}`)
    expect(calls).toContain(`lt:claimed_at<${ago(10 * MIN)}`)
  })

  it("orders by updated_at (least recently checked), not created_at", async () => {
    const { db } = fakeDb([
      { reference: ref(1), status: "pending", created_at: ago(120 * MIN), claimed_at: null, updated_at: ago(1 * MIN) },
      { reference: ref(2), status: "pending", created_at: ago(6 * MIN), claimed_at: null, updated_at: ago(6 * MIN) },
      { reference: ref(3), status: "confirming", created_at: ago(60 * MIN), claimed_at: ago(30 * MIN), updated_at: ago(30 * MIN) },
    ])
    const due = await listDueHubtelPayments(db as any, NOW)
    expect(due.map((r) => r.reference)).toEqual([ref(3), ref(2), ref(1)])
  })

  it("60 old rows just checked plus one new due row → the new row is in the first run", async () => {
    const rows: Row[] = Array.from({ length: 60 }, (_, i) => ({
      reference: ref(i + 1), status: "pending", created_at: ago((600 - i) * MIN), claimed_at: null, updated_at: ago(1 * MIN),
    }))
    const fresh = ref(999)
    rows.push({ reference: fresh, status: "pending", created_at: ago(6 * MIN), claimed_at: null })
    const { db } = fakeDb(rows)
    const confirm = vi.fn(async () => "pending" as const)
    const out = await runHubtelPaymentsSweep({ listDue: (now) => listDueHubtelPayments(db as any, now), confirm, now: () => NOW })
    expect(confirm.mock.calls.map((c: unknown[]) => c[0])).toContain(fresh)
    expect(out.processed).toBe(50)
  })

  it("never-resolving rows take turns across runs, and a row that becomes due mid-way is reached at once", async () => {
    const start = NOW.getTime()
    const stamp = (ms: number) => new Date(start + ms).toISOString()
    const rows: Row[] = Array.from({ length: 60 }, (_, i) => ({
      reference: ref(i + 1), status: "pending", created_at: stamp(-120 * MIN + i), claimed_at: null,
    }))
    const { db } = fakeDb(rows)
    const fresh = ref(999)
    const seen = new Map<string, number[]>()
    let clock = start
    const confirm = async (r: string) => {
      // What recordCheck does: the check stamps updated_at and the row stays pending.
      rows.find((x) => x.reference === r)!.updated_at = new Date(clock).toISOString()
      seen.set(r, [...(seen.get(r) ?? []), clock])
      return "pending" as const
    }
    for (let m = 0; m <= 20; m += 5) {
      clock = start + m * MIN
      // Arrives between the 10 and 15 minute runs; due from minute 16, so the minute-20 run must reach it.
      if (m === 15) rows.push({ reference: fresh, status: "pending", created_at: stamp(11 * MIN), claimed_at: null, updated_at: stamp(11 * MIN) })
      await runHubtelPaymentsSweep({ listDue: (now) => listDueHubtelPayments(db as any, now), confirm, now: () => new Date(clock) })
    }
    expect(seen.get(fresh)).toEqual([start + 20 * MIN])
    // 60 rows, 50 slots: a row may miss one run, but never two in a row.
    for (let i = 1; i <= 60; i++) {
      const checks = seen.get(ref(i))!
      expect(checks[0]).toBeLessThanOrEqual(start + 5 * MIN)
      for (let k = 1; k < checks.length; k++) expect(checks[k] - checks[k - 1]).toBeLessThanOrEqual(10 * MIN)
      expect(checks.at(-1)).toBeGreaterThanOrEqual(start + 15 * MIN)
    }
  })

  it("caps at 50, oldest first across both statuses", async () => {
    const rows: Row[] = []
    for (let i = 0; i < 40; i++) rows.push({ reference: ref(100 + i), status: "pending", created_at: ago((100 - i) * MIN), claimed_at: null })
    for (let i = 0; i < 40; i++) rows.push({ reference: ref(200 + i), status: "confirming", created_at: ago((200 - i) * MIN), claimed_at: ago(20 * MIN) })
    const { db } = fakeDb(rows)
    const due = await listDueHubtelPayments(db as any, NOW)
    expect(SWEEP_LIMIT).toBe(50)
    expect(due).toHaveLength(50)
    expect(due.slice(0, 40).every((r) => r.status === "confirming")).toBe(true)
    expect(due.slice(40).map((r) => r.reference)).toEqual(rows.slice(0, 10).map((r) => r.reference))
    const times = due.map((r) => new Date(r.updated_at).getTime())
    expect([...times].sort((a, b) => a - b)).toEqual(times)
  })

  describe("failed rows (late payments)", () => {
    const HOUR = 60 * MIN
    const failed = (n: number, ageMs: number, checkedMsAgo: number): Row => ({
      reference: ref(n), status: "failed", created_at: ago(ageMs), claimed_at: null, updated_at: ago(checkedMsAgo),
    })

    it("picks failed rows under 72h old not checked for over an hour; 73h old and checked 30 min ago are not picked", async () => {
      const { db } = fakeDb([
        failed(1, 10 * HOUR, 2 * HOUR),      // due
        failed(2, 73 * HOUR, 2 * HOUR),      // too old
        failed(3, 10 * HOUR, 30 * MIN),      // checked 30 minutes ago
        failed(4, 72 * HOUR, 2 * HOUR),      // exactly 72h: out
        failed(5, 10 * HOUR, 60 * MIN),      // exactly 1h: not yet
      ])
      const due = await listDueHubtelPayments(db as any, NOW)
      expect(due.map((r) => r.reference)).toEqual([ref(1)])
    })

    it("failed rows sort with the rest by updated_at, inside the same cap", async () => {
      const rows: Row[] = [
        failed(1, 10 * HOUR, 3 * HOUR),
        { reference: ref(2), status: "pending", created_at: ago(10 * MIN), claimed_at: null, updated_at: ago(2 * HOUR) },
        failed(3, 10 * HOUR, 90 * MIN),
        { reference: ref(4), status: "confirming", created_at: ago(5 * HOUR), claimed_at: ago(20 * MIN), updated_at: ago(20 * MIN) },
      ]
      const { db } = fakeDb(rows)
      expect((await listDueHubtelPayments(db as any, NOW)).map((r) => r.reference)).toEqual([ref(1), ref(2), ref(3), ref(4)])
      const { db: db2 } = fakeDb(Array.from({ length: 60 }, (_, i) => failed(i + 1, 10 * HOUR, 2 * HOUR + i)))
      expect(await listDueHubtelPayments(db2 as any, NOW)).toHaveLength(SWEEP_LIMIT)
    })

    it("a failed row with refused_at is never picked: nothing reached Hubtel", async () => {
      const refused: Row = { ...failed(5, 10 * HOUR, 2 * HOUR), refused_at: ago(10 * HOUR) }
      const plain = failed(6, 10 * HOUR, 2 * HOUR)
      const { db } = fakeDb([refused, plain])
      expect((await listDueHubtelPayments(db as any, NOW)).map((r) => r.reference)).toEqual([ref(6)])
    })

    it("a late Paid found by the sweep → needs_review, one alert, no handler (real confirm)", async () => {
      const row: Row = failed(7, 10 * HOUR, 2 * HOUR)
      const { db } = fakeDb([row])
      const stored: HubtelPaymentRow = {
        reference: ref(7), amount_pesewas: 2000, status: "failed", claimed_at: null,
        created_at: row.created_at, expires_at: ago(9 * HOUR),
      }
      const store: HubtelPaymentStore = {
        load: async () => ({ ...stored }),
        claim: vi.fn(async () => null),
        hasLiveSibling: vi.fn(async () => false),
        hasPaidSibling: vi.fn(async () => false),
        update: async (_r, patch, guard) => {
          if (!guard.status.includes(stored.status)) return false
          Object.assign(stored, patch)
          return true
        },
      }
      const onChargeSuccess = vi.fn(async () => null)
      const onChargeFailed = vi.fn(async () => null)
      const notify = vi.fn(async () => {})
      const deps = {
        store, onChargeSuccess, onChargeFailed, notify, now: () => NOW,
        checkStatus: async () => ({ kind: "paid" as const, amountPesewas: 2000, paymentMethod: "mobilemoney", raw: {} }),
      }
      const out = await runHubtelPaymentsSweep({
        listDue: (now) => listDueHubtelPayments(db as any, now),
        confirm: (r) => confirmHubtelPayment(r, deps),
        now: () => NOW,
      })
      expect(out.outcomes.needs_review).toBe(1)
      expect(stored.status).toBe("needs_review")
      expect(onChargeSuccess).not.toHaveBeenCalled()
      expect(onChargeFailed).not.toHaveBeenCalled()
      expect(notify).toHaveBeenCalledTimes(1)
      // Nothing is due on the next run: the row is no longer failed.
      row.status = "needs_review"
      expect(await listDueHubtelPayments(db as any, NOW)).toEqual([])
    })
  })

  it("throws on a database error (the route reports it)", async () => {
    const { db } = fakeDb([], { error: "boom" })
    await expect(listDueHubtelPayments(db as any, NOW)).rejects.toThrow(/boom/)
  })
})

describe("runHubtelPaymentsSweep", () => {
  const rows = (n: number): DueRow[] => Array.from({ length: n }, (_, i) => ({ reference: ref(i + 1), status: "pending", updated_at: ago((n - i) * MIN) }))

  it("confirms each row one at a time and counts outcomes", async () => {
    const outcomes = ["fulfilled", "failed", "pending", "needs_review", "ignored", "fulfilled"] as const
    let inFlight = 0
    let maxInFlight = 0
    const confirm = vi.fn(async (r: string) => {
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((res) => setTimeout(res, 1))
      inFlight--
      return outcomes[parseInt(r, 16) - 1]
    })
    const listDue = vi.fn(async () => rows(6))
    const out = await runHubtelPaymentsSweep({ listDue, confirm, now: () => NOW })
    expect(listDue).toHaveBeenCalledWith(NOW)
    expect(confirm.mock.calls.map((c) => c[0])).toEqual(rows(6).map((r) => r.reference))
    expect(maxInFlight).toBe(1)
    expect(out).toEqual({ processed: 6, skipped: 0, outcomes: { fulfilled: 2, failed: 1, pending: 1, needs_review: 1, ignored: 1, check_error: 0, error: 0 } })
  })

  it("one row throwing does not stop the rest; it counts as error", async () => {
    const confirm = vi.fn(async (r: string) => {
      if (r === ref(2)) throw new Error("store down")
      return "pending" as const
    })
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    const out = await runHubtelPaymentsSweep({ listDue: async () => rows(3), confirm, now: () => NOW })
    expect(confirm).toHaveBeenCalledTimes(3)
    expect(out).toEqual({ processed: 3, skipped: 0, outcomes: { fulfilled: 0, failed: 0, pending: 2, needs_review: 0, ignored: 0, check_error: 0, error: 1 } })
    expect(err).toHaveBeenCalled()
    err.mockRestore()
  })

  it("no due rows → processed 0, all zero", async () => {
    const confirm = vi.fn()
    const out = await runHubtelPaymentsSweep({ listDue: async () => [], confirm, now: () => NOW })
    expect(confirm).not.toHaveBeenCalled()
    expect(out).toEqual({ processed: 0, skipped: 0, outcomes: { fulfilled: 0, failed: 0, pending: 0, needs_review: 0, ignored: 0, check_error: 0, error: 0 } })
  })

  it("an outcome matching an inherited Object property counts as error, not as a stray key", async () => {
    const confirm = vi.fn(async () => "toString" as never)
    const out = await runHubtelPaymentsSweep({ listDue: async () => rows(1), confirm, now: () => NOW })
    expect(out.outcomes).toEqual({ fulfilled: 0, failed: 0, pending: 0, needs_review: 0, ignored: 0, check_error: 0, error: 1 })
    expect(Object.hasOwn(out.outcomes, "toString")).toBe(false)
  })

  it("counts check_error separately from pending", async () => {
    const confirm = vi.fn(async (r: string) => (r === ref(1) ? "check_error" as const : "pending" as const))
    const out = await runHubtelPaymentsSweep({ listDue: async () => rows(2), confirm, now: () => NOW })
    expect(out.outcomes).toMatchObject({ check_error: 1, pending: 1, error: 0 })
  })

  describe("persistent-failure alerts", () => {
    /** In-memory admin_settings: the select/upsert/delete chain sendSweepAlert uses. */
    function fakeSettings(opts: { readThrows?: boolean; readError?: boolean; writeThrows?: boolean } = {}) {
      const store = new Map<string, any>()
      const db = {
        from(table: string) {
          expect(table).toBe("admin_settings")
          return {
            select: () => ({
              eq: (_c: string, key: string) => ({
                maybeSingle: async () => {
                  if (opts.readThrows) throw new Error("settings down")
                  if (opts.readError) return { data: null, error: { message: "settings down" } }
                  return { data: store.has(key) ? { value: store.get(key) } : null, error: null }
                },
              }),
            }),
            upsert: async (row: { key: string; value: unknown }) => {
              if (opts.writeThrows) throw new Error("settings down")
              store.set(row.key, row.value)
              return { error: null }
            },
            delete: () => ({ eq: async (_c: string, key: string) => { store.delete(key); return { error: null } } }),
          }
        },
      }
      return { db: db as any, store }
    }

    /** One sweep run at `at`, with the real throttle over the fake settings table. */
    const run = (db: any, notify: (m: string, t: string) => Promise<void>, at: Date, deps: Partial<SweepDeps> = {}) => {
      const now = () => at
      return runHubtelPaymentsSweep({
        listDue: async () => rows(2),
        confirm: async () => "check_error",
        now,
        alert: (m) => sendSweepAlert(db, m, { notify, now }),
        ...deps,
      })
    }
    const later = (ms: number) => new Date(NOW.getTime() + ms)
    const quiet = () => {
      const e = vi.spyOn(console, "error").mockImplementation(() => {})
      const w = vi.spyOn(console, "warn").mockImplementation(() => {})
      return () => { e.mockRestore(); w.mockRestore() }
    }

    it("2 failing runs in an hour → 1 alert; a run after the hour → another", async () => {
      const { db } = fakeSettings()
      const notify = vi.fn(async () => {})
      await run(db, notify, NOW)
      await run(db, notify, later(5 * MIN))
      expect(notify).toHaveBeenCalledTimes(1)
      await run(db, notify, later(59 * MIN))
      expect(notify).toHaveBeenCalledTimes(1)
      await run(db, notify, later(60 * MIN))
      expect(notify).toHaveBeenCalledTimes(2)
    })

    it("no errors → no alert and the throttle table is not touched", async () => {
      const { db, store } = fakeSettings()
      const notify = vi.fn(async () => {})
      await run(db, notify, NOW, { confirm: async () => "pending" })
      expect(notify).not.toHaveBeenCalled()
      expect(store.size).toBe(0)
    })

    it("a row that throws (error) also alerts; the alert carries counts, no references or error text", async () => {
      const restore = quiet()
      const { db } = fakeSettings()
      const notify = vi.fn(async () => {})
      await run(db, notify, NOW, { confirm: async () => { throw new Error("db at 233241234567") } })
      expect(notify).toHaveBeenCalledTimes(1)
      const [message, type] = notify.mock.calls[0] as unknown as [string, string]
      expect(message).toContain("2 of 2")
      expect(message).not.toContain(ref(1))
      expect(message).not.toContain("233241234567")
      expect(type).toBe("hubtel_payments_sweep")
      restore()
    })

    it("the row query throwing → one throttled alert, then the error still propagates", async () => {
      const { db } = fakeSettings()
      const notify = vi.fn(async () => {})
      const listDue = async () => { throw new Error("timeout at 233241234567") }
      await expect(run(db, notify, NOW, { listDue })).rejects.toThrow(/timeout/)
      await expect(run(db, notify, later(5 * MIN), { listDue })).rejects.toThrow(/timeout/)
      expect(notify).toHaveBeenCalledTimes(1)
      expect((notify.mock.calls[0] as unknown as [string])[0]).not.toContain("233241234567")
    })

    it.each([[{ readThrows: true }], [{ readError: true }]])("a failed throttle read (%o) does not break the sweep and still alerts", async (o) => {
      const restore = quiet()
      const { db } = fakeSettings(o)
      const notify = vi.fn(async () => {})
      const out = await run(db, notify, NOW)
      expect(out.processed).toBe(2)
      expect(notify).toHaveBeenCalledTimes(1)
      restore()
    })

    it("a failed stamp write does not stop the alert or the sweep", async () => {
      const restore = quiet()
      const { db } = fakeSettings({ writeThrows: true })
      const notify = vi.fn(async () => {})
      const out = await run(db, notify, NOW)
      expect(out.processed).toBe(2)
      expect(notify).toHaveBeenCalledTimes(1)
      restore()
    })

    it("a failed send puts the stamp back, so the next run tries again", async () => {
      const restore = quiet()
      const { db, store } = fakeSettings()
      const notify = vi.fn(async () => {})
      notify.mockRejectedValueOnce(new Error("sms down"))
      const out = await run(db, notify, NOW)
      expect(out.processed).toBe(2)
      expect(store.size).toBe(0)
      await run(db, notify, later(5 * MIN))
      expect(notify).toHaveBeenCalledTimes(2)
      restore()
    })

    it("an alert dep that throws never breaks the run", async () => {
      const restore = quiet()
      const out = await runHubtelPaymentsSweep({
        listDue: async () => rows(1), confirm: async () => "check_error", now: () => NOW,
        alert: async () => { throw new Error("nope") },
      })
      expect(out.processed).toBe(1)
      restore()
    })
  })

  describe("time budget", () => {
    /** Each confirm takes `stepMs` on an injected clock. */
    const timed = (stepMs: number, listMs = 0) => {
      let t = NOW.getTime()
      const confirm = vi.fn(async () => { t += stepMs; return "pending" as const })
      return { confirm, now: () => new Date(t), advance: (ms: number) => { t += ms }, listMs }
    }

    it("stops starting rows once the deadline has passed and reports the rest as skipped", async () => {
      const c = timed(30_000)
      const out = await runHubtelPaymentsSweep({ listDue: async () => rows(5), confirm: c.confirm, now: c.now, deadlineMs: 85_000 })
      expect(c.confirm).toHaveBeenCalledTimes(3) // started at 0s, 30s, 60s; at 90s nothing new starts
      expect(out.processed).toBe(3)
      expect(out.skipped).toBe(2)
    })

    it("elapsed exactly equal to the deadline stops the run", async () => {
      const c = timed(85_000)
      const out = await runHubtelPaymentsSweep({ listDue: async () => rows(4), confirm: c.confirm, now: c.now, deadlineMs: 85_000 })
      expect(out).toMatchObject({ processed: 1, skipped: 3 })
    })

    it("defaults to 85 seconds", async () => {
      const c = timed(40_000)
      const out = await runHubtelPaymentsSweep({ listDue: async () => rows(5), confirm: c.confirm, now: c.now })
      expect(out).toMatchObject({ processed: 3, skipped: 2 }) // started at 0s, 40s, 80s
    })

    it("time spent on the row query counts against the budget", async () => {
      const c = timed(1_000)
      const listDue = async () => { c.advance(90_000); return rows(3) }
      const out = await runHubtelPaymentsSweep({ listDue, confirm: c.confirm, now: c.now })
      expect(c.confirm).not.toHaveBeenCalled()
      expect(out).toMatchObject({ processed: 0, skipped: 3 })
    })

    it("a throwing row still uses up time and the budget is still enforced", async () => {
      let t = NOW.getTime()
      const confirm = vi.fn(async () => { t += 50_000; throw new Error("store down") })
      const err = vi.spyOn(console, "error").mockImplementation(() => {})
      const out = await runHubtelPaymentsSweep({ listDue: async () => rows(4), confirm, now: () => new Date(t) })
      expect(out).toMatchObject({ processed: 2, skipped: 2 })
      expect(out.outcomes.error).toBe(2)
      err.mockRestore()
    })
  })
})
