import { describe, it, expect, vi } from "vitest"
import { reminderStageDue, runPriceReminders, PRICE_REMINDER_LINK, type PriceReminderDeps } from "./price-reminders"
import { SMSTemplates } from "@/lib/sms-service"
import { EmailTemplates } from "@/lib/email-service"

const MIN = 60 * 1000
const HOUR = 60 * MIN
const NOW = new Date("2026-11-03T12:00:00.000Z")
const ago = (ms: number) => new Date(NOW.getTime() - ms)

describe("reminderStageDue", () => {
  it("returns the highest passed stage above sent", () => {
    expect(reminderStageDue(ago(9 * MIN), NOW, 0)).toBe(0)
    expect(reminderStageDue(ago(10 * MIN), NOW, 0)).toBe(1)
    expect(reminderStageDue(ago(47 * HOUR), NOW, 0)).toBe(1)
    expect(reminderStageDue(ago(48 * HOUR), NOW, 0)).toBe(2)
    expect(reminderStageDue(ago(72 * HOUR), NOW, 0)).toBe(3)
    expect(reminderStageDue(ago(72 * HOUR), NOW, 3)).toBe(0)
  })

  it("is 0 once the passed stage was already sent", () => {
    expect(reminderStageDue(ago(47 * HOUR), NOW, 1)).toBe(0)
    expect(reminderStageDue(ago(48 * HOUR), NOW, 1)).toBe(2)
    expect(reminderStageDue(ago(71 * HOUR), NOW, 2)).toBe(0)
    expect(reminderStageDue(ago(100 * HOUR), NOW, 2)).toBe(3)
  })

  it("is 0 for a bad date", () => {
    expect(reminderStageDue(new Date("nope"), NOW, 0)).toBe(0)
  })
})

// ───────────────────────── fake db ─────────────────────────

type Row = Record<string, any>

function cmp(v: any, op: string, raw: string): boolean {
  const num = (x: any) => (typeof x === "number" ? x : Number(x))
  const val: any = raw === "null" ? null : raw === "true" ? true : raw === "false" ? false : raw
  switch (op) {
    case "eq":
      return typeof v === "number" ? v === num(val) : v === val
    case "lt":
      return typeof v === "number" ? v < num(val) : String(v) < String(val)
    case "lte":
      return typeof v === "number" ? v <= num(val) : String(v) <= String(val)
    case "is":
      return val === null ? v == null : v === val
    default:
      throw new Error(`fake: unsupported op ${op}`)
  }
}

/** Parses the PostgREST or-string the scan uses: and(col.op.val,...),and(...) */
function orMatches(row: Row, expr: string): boolean {
  const groups = expr.match(/and\(([^)]*)\)/g)
  if (!groups) throw new Error(`fake: unsupported or() ${expr}`)
  return groups.some((g) =>
    g
      .slice(4, -1)
      .split(",")
      .every((term) => {
        const [col, op, ...rest] = term.split(".")
        return cmp(row[col], op, rest.join("."))
      })
  )
}

function fakeDb(opts: {
  shops: Row[]
  users?: Row[]
  /** Called before a claim applies; return false to simulate another run winning it. */
  claimWins?: (id: string) => boolean
}) {
  const shops = opts.shops.map((s) => ({ price_reminders_sent: 0, is_active: false, is_blocked: false, prices_set_at: null, ...s }))
  const users = opts.users ?? []
  const claims: { id: string; stage: number }[] = []

  function query(table: string, rows: Row[], mode: "select" | "update", patch?: Row) {
    const filters: ((r: Row) => boolean)[] = []
    const sorts: { col: string; asc: boolean }[] = []
    let limit = Infinity
    const q: any = {
      select: () => q,
      eq: (c: string, v: any) => (filters.push((r) => r[c] === v), q),
      is: (c: string, v: any) => (filters.push((r) => (v === null ? r[c] == null : r[c] === v)), q),
      not: (c: string, op: string, v: any) => (filters.push((r) => !cmp(r[c], op, String(v))), q),
      lt: (c: string, v: any) => (filters.push((r) => cmp(r[c], "lt", String(v))), q),
      lte: (c: string, v: any) => (filters.push((r) => cmp(r[c], "lte", String(v))), q),
      in: (c: string, vs: any[]) => (filters.push((r) => vs.includes(r[c])), q),
      or: (expr: string) => (filters.push((r) => orMatches(r, expr)), q),
      order: (col: string, o?: { ascending?: boolean }) => (sorts.push({ col, asc: o?.ascending !== false }), q),
      limit: (n: number) => ((limit = n), q),
      then: (resolve: any, reject: any) => {
        try {
          let hit = rows.filter((r) => filters.every((f) => f(r)))
          if (mode === "update") {
            hit = hit.filter((r) => (opts.claimWins ? opts.claimWins(r.id) : true))
            for (const r of hit) {
              Object.assign(r, patch)
              claims.push({ id: r.id, stage: patch!.price_reminders_sent })
            }
            return Promise.resolve({ data: hit.map((r) => ({ id: r.id })), error: null }).then(resolve, reject)
          }
          hit = [...hit].sort((a, b) => {
            for (const s of sorts) {
              if (a[s.col] === b[s.col]) continue
              return (a[s.col] < b[s.col] ? -1 : 1) * (s.asc ? 1 : -1)
            }
            return 0
          })
          return Promise.resolve({ data: hit.slice(0, limit).map((r) => ({ ...r })), error: null }).then(resolve, reject)
        } catch (e) {
          return Promise.reject(e).then(resolve, reject)
        }
      },
    }
    void table
    return q
  }

  const db = {
    shops,
    claims,
    from(table: string) {
      const rows = table === "users" ? users : shops
      return {
        select: (_c?: string) => query(table, rows, "select"),
        update: (patch: Row) => query(table, rows, "update", patch),
      }
    },
  }
  return db
}

function offered() {
  return { parent: {}, costs: new Map([["pkg1", { cost: 5 }]]) }
}

function deps(over: Partial<PriceReminderDeps> = {}) {
  return {
    sendSMS: vi.fn(async () => ({ success: true })),
    sendEmail: vi.fn(async () => ({ success: true })),
    subAgentCosts: vi.fn(async () => offered()),
    ...over,
  } as unknown as PriceReminderDeps & { sendSMS: any; sendEmail: any; subAgentCosts: any }
}

const joiner = (id: string, createdAgoMs: number, extra: Row = {}): Row => ({
  id,
  user_id: `u-${id}`,
  parent_shop_id: "parent1",
  joined_via: "storefront",
  created_at: ago(createdAgoMs).toISOString(),
  ...extra,
})
const user = (id: string) => ({ id: `u-${id}`, phone_number: `02400000${id.length}`, email: `${id}@example.com` })

describe("runPriceReminders", () => {
  it("sends SMS and email with the setup link for a stage-1 joiner and claims stage 1", async () => {
    const db = fakeDb({ shops: [joiner("a", 15 * MIN)], users: [user("a")] })
    const d = deps()
    const res = await runPriceReminders(db, NOW, d)
    expect(res).toMatchObject({ scanned: 1, sent: 1, skipped_no_catalog: 0, claimed_elsewhere: 0 })
    expect(db.shops[0].price_reminders_sent).toBe(1)
    expect(d.sendSMS).toHaveBeenCalledTimes(1)
    expect(d.sendSMS.mock.calls[0][0]).toMatchObject({ phone: user("a").phone_number, message: SMSTemplates.subAgentPriceReminder(1) })
    expect(d.sendEmail).toHaveBeenCalledTimes(1)
    expect(d.sendEmail.mock.calls[0][0].to).toEqual([{ email: "a@example.com" }])
    expect(d.sendEmail.mock.calls[0][0].htmlContent).toContain("/dashboard/shop-pricing?setup=1")
    expect(d.subAgentCosts).toHaveBeenCalledWith("parent1", null, db)
  })

  it("does nothing for a joiner under 10 minutes old", async () => {
    const db = fakeDb({ shops: [joiner("a", 9 * MIN)], users: [user("a")] })
    const d = deps()
    const res = await runPriceReminders(db, NOW, d)
    expect(res.sent).toBe(0)
    expect(db.claims).toEqual([])
    expect(d.sendSMS).not.toHaveBeenCalled()
  })

  it("overdue catch-up sends only the latest stage, once, and marks earlier ones passed", async () => {
    const db = fakeDb({ shops: [joiner("a", 80 * HOUR)], users: [user("a")] })
    const d = deps()
    const res = await runPriceReminders(db, NOW, d)
    expect(res.sent).toBe(1)
    expect(db.claims).toEqual([{ id: "a", stage: 3 }])
    expect(db.shops[0].price_reminders_sent).toBe(3)
    expect(d.sendSMS).toHaveBeenCalledTimes(1)
    expect(d.sendSMS.mock.calls[0][0].message).toBe(SMSTemplates.subAgentPriceReminder(3))
    expect(d.sendEmail).toHaveBeenCalledTimes(1)

    // A second run finds nothing left to send.
    const again = await runPriceReminders(db, NOW, d)
    expect(again.scanned).toBe(0)
    expect(d.sendSMS).toHaveBeenCalledTimes(1)
  })

  it("no catalog: skips without sending but advances the counter; the next due stage sends normally", async () => {
    const db = fakeDb({ shops: [joiner("a", 15 * MIN)], users: [user("a")] })
    const d = deps({ subAgentCosts: vi.fn(async () => ({ parent: {}, costs: new Map([["pkg1", null]]) })) as any })
    const res = await runPriceReminders(db, NOW, d)
    expect(res).toMatchObject({ scanned: 1, sent: 0, skipped_no_catalog: 1 })
    expect(db.shops[0].price_reminders_sent).toBe(1)
    expect(d.sendSMS).not.toHaveBeenCalled()
    expect(d.sendEmail).not.toHaveBeenCalled()

    // Parent sets a catalog later; at 48h stage 2 goes out.
    const later = new Date(NOW.getTime() + 48 * HOUR)
    const d2 = deps()
    const res2 = await runPriceReminders(db, later, d2)
    expect(res2.sent).toBe(1)
    expect(db.shops[0].price_reminders_sent).toBe(2)
    expect(d2.sendSMS.mock.calls[0][0].message).toBe(SMSTemplates.subAgentPriceReminder(2))
  })

  it("an empty parent offer (no packages at all) is also no catalog", async () => {
    const db = fakeDb({ shops: [joiner("a", 15 * MIN)], users: [user("a")] })
    const d = deps({ subAgentCosts: vi.fn(async () => ({ parent: {}, costs: new Map() })) as any })
    const res = await runPriceReminders(db, NOW, d)
    expect(res.skipped_no_catalog).toBe(1)
    expect(d.sendSMS).not.toHaveBeenCalled()
  })

  it("a joiner with no parent shop is skipped as no catalog without calling subAgentCosts", async () => {
    const db = fakeDb({ shops: [joiner("a", 15 * MIN, { parent_shop_id: null })], users: [user("a")] })
    const d = deps()
    const res = await runPriceReminders(db, NOW, d)
    expect(res.skipped_no_catalog).toBe(1)
    expect(d.subAgentCosts).not.toHaveBeenCalled()
    expect(d.sendSMS).not.toHaveBeenCalled()
  })

  it("a catalog read error leaves the stage unclaimed for the next run and sends nothing", async () => {
    const db = fakeDb({ shops: [joiner("a", 15 * MIN)], users: [user("a")] })
    const d = deps({ subAgentCosts: vi.fn(async () => { throw new Error("read failed") }) as any })
    const res = await runPriceReminders(db, NOW, d)
    expect(res.sent).toBe(0)
    expect(res.read_errors).toBe(1)
    expect(db.claims).toEqual([])
    expect(d.sendSMS).not.toHaveBeenCalled()
  })

  it("a read error that persists past the 1-hour grace claims and skips the stage, so it cannot block the scan", async () => {
    // Stage 1 due at 10 min; joined 2 h ago, so it has been overdue for 110 min.
    const db = fakeDb({ shops: [joiner("a", 2 * HOUR)], users: [user("a")] })
    const d = deps({ subAgentCosts: vi.fn(async () => { throw new Error("read failed") }) as any })
    const res = await runPriceReminders(db, NOW, d)
    expect(res.read_errors).toBe(1)
    expect(res.skipped_no_catalog).toBe(1)
    expect(res.sent).toBe(0)
    expect(db.claims).toEqual([{ id: "a", stage: 1 }])
    expect(d.sendSMS).not.toHaveBeenCalled()
  })

  it("scans lowest counter first, then oldest join, capped at 100", async () => {
    const shops: Row[] = []
    // 100 old rows already at stage 2 waiting for stage 3, plus one fresh stage-1 joiner.
    for (let i = 0; i < 100; i++) shops.push(joiner(`old${i}`, 80 * HOUR, { price_reminders_sent: 2 }))
    shops.push(joiner("fresh", 15 * MIN))
    const db = fakeDb({ shops, users: [user("fresh")] })
    const d = deps()
    const res = await runPriceReminders(db, NOW, d)
    expect(res.scanned).toBe(100)
    expect(db.claims.some((c) => c.id === "fresh" && c.stage === 1)).toBe(true)
    expect(db.claims.filter((c) => c.id.startsWith("old"))).toHaveLength(99)
  })

  it("a lost claim sends nothing", async () => {
    const db = fakeDb({ shops: [joiner("a", 15 * MIN)], users: [user("a")], claimWins: () => false })
    const d = deps()
    const res = await runPriceReminders(db, NOW, d)
    expect(res).toMatchObject({ scanned: 1, sent: 0, claimed_elsewhere: 1 })
    expect(d.sendSMS).not.toHaveBeenCalled()
    expect(d.sendEmail).not.toHaveBeenCalled()
  })

  it("opened or blocked shops are never candidates", async () => {
    const db = fakeDb({
      shops: [
        joiner("priced", 15 * MIN, { prices_set_at: ago(5 * MIN).toISOString() }),
        joiner("active", 15 * MIN, { is_active: true }),
        joiner("blocked", 15 * MIN, { is_blocked: true }),
        joiner("invite", 15 * MIN, { joined_via: null }),
      ],
      users: [user("priced"), user("active"), user("blocked"), user("invite")],
    })
    const d = deps()
    const res = await runPriceReminders(db, NOW, d)
    expect(res.scanned).toBe(0)
    expect(db.claims).toEqual([])
    expect(d.sendSMS).not.toHaveBeenCalled()
    expect(d.sendEmail).not.toHaveBeenCalled()
  })

  it("re-checks open/blocked rows in code even if the query returned them", async () => {
    const shops = [joiner("blocked", 15 * MIN, { is_blocked: true, price_reminders_sent: 0, is_active: false, prices_set_at: null })]
    const leaky = {
      from(table: string) {
        const rows = table === "users" ? [user("blocked")] : shops
        const q: any = {
          select: () => q, eq: () => q, is: () => q, not: () => q, lt: () => q, lte: () => q, in: () => q, or: () => q,
          order: () => q, limit: () => q,
          then: (res: any) => res({ data: rows, error: null }),
        }
        return { select: () => q, update: () => { throw new Error("must not claim") } }
      },
    }
    const d = deps()
    const res = await runPriceReminders(leaky, NOW, d)
    expect(res.sent).toBe(0)
    expect(d.sendSMS).not.toHaveBeenCalled()
  })

  it("a send failure (throw or success:false) does not throw and logs no phone or email", async () => {
    const db = fakeDb({ shops: [joiner("a", 15 * MIN), joiner("b", 15 * MIN)], users: [user("a"), user("b")] })
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    const d = deps({
      sendSMS: vi.fn(async () => { throw new Error(`boom for ${user("a").phone_number}`) }) as any,
      sendEmail: vi.fn(async () => ({ success: false, error: "rejected a@example.com" })) as any,
    })
    const res = await runPriceReminders(db, NOW, d)
    expect(res.sent).toBe(2)
    expect(d.sendEmail).toHaveBeenCalledTimes(2)
    const logged = [...warn.mock.calls, ...error.mock.calls].flat().map(String).join("\n")
    expect(logged).not.toContain(user("a").phone_number)
    expect(logged).not.toContain("@example.com")
    warn.mockRestore()
    error.mockRestore()
  })

  it("a joiner with no phone or email still has the stage claimed", async () => {
    const db = fakeDb({ shops: [joiner("a", 15 * MIN)], users: [{ id: "u-a", phone_number: null, email: null }] })
    const d = deps()
    await runPriceReminders(db, NOW, d)
    expect(db.shops[0].price_reminders_sent).toBe(1)
    expect(d.sendSMS).not.toHaveBeenCalled()
    expect(d.sendEmail).not.toHaveBeenCalled()
  })

  it("reads each parent's offer once per run", async () => {
    const db = fakeDb({ shops: [joiner("a", 15 * MIN), joiner("b", 15 * MIN)], users: [user("a"), user("b")] })
    const d = deps()
    await runPriceReminders(db, NOW, d)
    expect(d.subAgentCosts).toHaveBeenCalledTimes(1)
  })
})

describe("templates", () => {
  it("SMS starts DTGOD:, carries the link, and the last one says last reminder", () => {
    for (const s of [1, 2, 3]) {
      const m = SMSTemplates.subAgentPriceReminder(s)
      expect(m.startsWith("DTGOD:")).toBe(true)
      expect(m).toContain(PRICE_REMINDER_LINK)
    }
    expect(SMSTemplates.subAgentPriceReminder(3).toLowerCase()).toContain("last reminder")
  })

  it("email escapes the link", () => {
    const t = EmailTemplates.subAgentPriceReminder(1, `https://x/?a=1&b="2"`)
    expect(t.subject).toBeTruthy()
    expect(t.html).toContain("https://x/?a=1&amp;b=&quot;2&quot;")
    expect(t.html).not.toContain(`b="2"`)
    expect(EmailTemplates.subAgentPriceReminder(3, PRICE_REMINDER_LINK).subject.toLowerCase()).toContain("last reminder")
  })

  it("link is the www setup URL", () => {
    expect(PRICE_REMINDER_LINK).toBe("https://www.datagod.store/dashboard/shop-pricing?setup=1")
  })
})
