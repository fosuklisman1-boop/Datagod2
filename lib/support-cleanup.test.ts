import { describe, it, expect, vi, beforeEach } from "vitest"
import { makeFakeDb, type FakeCall, type FakeResult } from "@/app/api/support/_fake-db"

const h = vi.hoisted(() => ({ removed: [] as string[][] }))
vi.mock("@/lib/support-attachment", () => ({
  removeAttachments: vi.fn(async (_db: unknown, paths: string[]) => { h.removed.push(paths) }),
}))

import { deleteOldSupportData, SUPPORT_RETENTION_DAYS } from "./support-cleanup"

const NOW = new Date("2026-11-12T00:00:00.000Z")
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString()

type Row = Record<string, any>
type Tables = { support_threads: Row[]; support_messages: Row[]; complaints: Row[] }

/** In-memory tables that honour the filters the cleanup uses. `failDelete` makes deletes on a table error. */
function sim(tables: Tables, failDelete: string[] = [], afterSelect?: (table: string, t: Tables) => void) {
  const fake = makeFakeDb((c: FakeCall): FakeResult | undefined => {
    const rows = (tables as any)[c.table] as Row[]
    const matches = (r: Row) =>
      c.filters.every(([k, v]) => {
        const [col, op] = k.split(":")
        if (op === "in") return (v as unknown[]).includes(r[col])
        if (op === "lt") return Date.parse(r[col]) < Date.parse(v as string)
        if (op === "gt") return r[col] > (v as string)
        if (op === "not.is") return r[col] !== null && r[col] !== undefined
        if (!op) return r[col] === v
        return true
      })
    if (c.op === "delete") {
      if (failDelete.includes(c.table)) return { error: { message: "nope" } }
      const gone = rows.filter(matches)
      ;(tables as any)[c.table] = rows.filter((r) => !gone.includes(r))
      return { data: gone.map((r) => ({ id: r.id })) }
    }
    const sorted = rows.filter(matches).sort((a, b) => (a.id < b.id ? -1 : 1))
    const out = sorted.slice(0, c.limitN ?? sorted.length)
    if (c.table !== "support_messages") afterSelect?.(c.table, tables)
    return { data: out }
  })
  return fake
}

const pad = (n: number) => String(n).padStart(4, "0")
const thread = (id: string, status: string, ageDays: number): Row => ({ id, status, closed_at: status === "closed" ? daysAgo(ageDays) : null })
const complaint = (id: string, status: string, ageDays: number, evidence: any = null): Row => ({ id, status, updated_at: daysAgo(ageDays), evidence })

beforeEach(() => {
  h.removed.length = 0
})

describe("deleteOldSupportData", () => {
  it("uses a 90-day retention", () => {
    expect(SUPPORT_RETENTION_DAYS).toBe(90)
  })

  it("never selects an open thread; keeps closed at 89 days; deletes closed at 91 days", async () => {
    const t: Tables = {
      support_threads: [thread("t-open", "open", 200), thread("t-89", "closed", 89), thread("t-91", "closed", 91)],
      support_messages: [],
      complaints: [],
    }
    const fake = sim(t)
    const res = await deleteOldSupportData(fake.db as any, NOW)
    expect(res.closedThreads).toBe(1)
    expect(t.support_threads.map((r) => r.id).sort()).toEqual(["t-89", "t-open"])
    const select = fake.calls.find((c) => c.table === "support_threads" && c.op === "select")!
    expect(select.filters).toContainEqual(["status", "closed"])
  })

  it("keeps a pending complaint 400 days old; deletes a resolved one at 91 days and removes both evidence paths", async () => {
    const t: Tables = {
      support_threads: [],
      support_messages: [],
      complaints: [
        complaint("c-pending", "pending", 400, { balance_image_path: "keep/b.jpg" }),
        complaint("c-review", "in_review", 400),
        complaint("c-90", "resolved", 89),
        complaint("c-old", "resolved", 91, { balance_image_path: "u/b.jpg", momo_receipt_path: "u/m.png", balance_image_url: "https://stale" }),
        complaint("c-rej", "rejected", 120, { momo_receipt_path: "u/r.png" }),
        complaint("c-none", "resolved", 120),
      ],
    }
    const res = await deleteOldSupportData(sim(t).db as any, NOW)
    expect(res).toMatchObject({ legacyComplaints: 3, filesRemoved: 3 })
    expect(t.complaints.map((r) => r.id).sort()).toEqual(["c-90", "c-pending", "c-review"])
    expect(h.removed.flat().sort()).toEqual(["u/b.jpg", "u/m.png", "u/r.png"])
  })

  it("keeps the files of a thread that reopened between select and delete; removes files of deleted ones", async () => {
    const t: Tables = {
      support_threads: [thread("t-1", "closed", 100), thread("t-2", "closed", 100)],
      support_messages: [
        { id: "m1", thread_id: "t-1", attachment_path: "threads/u/t-1/a.png" },
        { id: "m2", thread_id: "t-2", attachment_path: "threads/u/t-2/b.png" },
      ],
      complaints: [],
    }
    let flipped = false
    const fake = sim(t, [], (table, tb) => {
      if (table === "support_threads" && !flipped) {
        flipped = true
        tb.support_threads.find((r) => r.id === "t-1")!.status = "open"
      }
    })
    await deleteOldSupportData(fake.db as any, NOW)
    expect(h.removed.flat()).toEqual(["threads/u/t-2/b.png"])
  })

  it("keeps the evidence of a complaint that went back to pending between select and delete", async () => {
    const t: Tables = {
      support_threads: [],
      support_messages: [],
      complaints: [
        complaint("c-1", "resolved", 100, { balance_image_path: "u/keep.jpg" }),
        complaint("c-2", "resolved", 100, { balance_image_path: "u/gone.jpg" }),
      ],
    }
    let flipped = false
    const fake = sim(t, [], (table, tb) => {
      if (table === "complaints" && !flipped) {
        flipped = true
        tb.complaints.find((r) => r.id === "c-1")!.status = "pending"
      }
    })
    await deleteOldSupportData(fake.db as any, NOW)
    expect(h.removed.flat()).toEqual(["u/gone.jpg"])
  })

  it("a storage failure after the delete does not stop the loop", async () => {
    const t: Tables = {
      support_threads: Array.from({ length: 250 }, (_, i) => thread(`t-${pad(i)}`, "closed", 100)),
      support_messages: [{ id: "m1", thread_id: "t-0001", attachment_path: "threads/a.png" }],
      complaints: [],
    }
    const { removeAttachments } = await import("@/lib/support-attachment")
    vi.mocked(removeAttachments).mockRejectedValueOnce(new Error("storage down"))
    const res = await deleteOldSupportData(sim(t).db as any, NOW)
    expect(res.closedThreads).toBe(250)
    expect(t.support_threads).toHaveLength(0)
  })

  it("collects message attachment paths for closed threads and removes them after the rows are deleted", async () => {
    const order: string[] = []
    const t: Tables = {
      support_threads: [thread("t-1", "closed", 100)],
      support_messages: [
        { id: "m1", thread_id: "t-1", attachment_path: "threads/u/t-1/a.png" },
        { id: "m2", thread_id: "t-1", attachment_path: null },
        { id: "m3", thread_id: "t-other", attachment_path: "threads/u/other/x.png" },
      ],
      complaints: [],
    }
    const fake = sim(t)
    const { removeAttachments } = await import("@/lib/support-attachment")
    vi.mocked(removeAttachments).mockImplementationOnce(async (_d, paths) => {
      order.push(`remove:${paths.join(",")}:threadsLeft=${t.support_threads.length}`)
    })
    const res = await deleteOldSupportData(fake.db as any, NOW)
    expect(order).toEqual(["remove:threads/u/t-1/a.png:threadsLeft=0"])
    expect(res).toMatchObject({ closedThreads: 1, filesRemoved: 1 })
    expect(t.support_threads).toHaveLength(0)
  })

  it("deletes 450 eligible rows in batches of at most 200", async () => {
    const t: Tables = {
      support_threads: Array.from({ length: 450 }, (_, i) => thread(`t-${pad(i)}`, "closed", 100)),
      support_messages: [],
      complaints: Array.from({ length: 450 }, (_, i) => complaint(`c-${pad(i)}`, "resolved", 100)),
    }
    const fake = sim(t)
    const res = await deleteOldSupportData(fake.db as any, NOW)
    expect(res).toMatchObject({ closedThreads: 450, legacyComplaints: 450 })
    expect(t.support_threads).toHaveLength(0)
    expect(t.complaints).toHaveLength(0)
    const deletes = fake.calls.filter((c) => c.op === "delete")
    expect(deletes).toHaveLength(6)
    for (const d of deletes) expect((d.filters.find(([k]) => k === "id:in")![1] as string[]).length).toBeLessThanOrEqual(200)
    for (const s of fake.calls.filter((c) => c.op === "select" && c.table !== "support_messages")) expect(s.limitN).toBe(200)
  })

  it("dryRun deletes nothing, touches no storage, and returns the counts a real run would", async () => {
    const make = (): Tables => ({
      support_threads: Array.from({ length: 250 }, (_, i) => thread(`t-${pad(i)}`, "closed", 100)),
      support_messages: [{ id: "m1", thread_id: "t-0001", attachment_path: "threads/a.png" }],
      complaints: Array.from({ length: 230 }, (_, i) =>
        complaint(`c-${pad(i)}`, "resolved", 100, i === 0 ? { balance_image_path: "u/b.jpg" } : null),
      ),
    })
    const dryTables = make()
    const dryFake = sim(dryTables)
    const dry = await deleteOldSupportData(dryFake.db as any, NOW, { dryRun: true })
    expect(dryFake.calls.some((c) => c.op !== "select")).toBe(false)
    expect(h.removed).toHaveLength(0)
    expect(dryTables.support_threads).toHaveLength(250)
    expect(dryTables.complaints).toHaveLength(230)

    const real = await deleteOldSupportData(sim(make()).db as any, NOW)
    expect(dry).toEqual(real)
    expect(dry).toMatchObject({ closedThreads: 250, legacyComplaints: 230, filesRemoved: 2 })
  })

  it("stops a table's loop when its delete fails, reports errors, and does not spin", async () => {
    const t: Tables = {
      support_threads: Array.from({ length: 450 }, (_, i) => thread(`t-${pad(i)}`, "closed", 100)),
      support_messages: [],
      complaints: [complaint("c-1", "resolved", 100)],
    }
    const fake = sim(t, ["support_threads"])
    const res = await deleteOldSupportData(fake.db as any, NOW)
    expect(res.errors).toBe(1)
    expect(res.closedThreads).toBe(0)
    expect(fake.calls.filter((c) => c.table === "support_threads" && c.op === "delete")).toHaveLength(1)
    expect(res.legacyComplaints).toBe(1)
  })

  it("does not delete a thread batch whose attachment paths could not be read", async () => {
    const t: Tables = { support_threads: [thread("t-1", "closed", 100)], support_messages: [], complaints: [] }
    const fake = makeFakeDb((c) => {
      if (c.table === "support_messages") return { error: { message: "boom" } }
      if (c.table === "support_threads" && c.op === "select") return { data: t.support_threads }
      return undefined
    })
    const res = await deleteOldSupportData(fake.db as any, NOW)
    expect(res.errors).toBe(1)
    expect(res.closedThreads).toBe(0)
    expect(fake.calls.some((c) => c.op === "delete")).toBe(false)
  })

  it("never selects or deletes a closed thread whose closed_at is null", async () => {
    const t: Tables = {
      support_threads: [{ id: "t-null", status: "closed", closed_at: null }, thread("t-old", "closed", 100)],
      support_messages: [],
      complaints: [],
    }
    const res = await deleteOldSupportData(sim(t).db as any, NOW)
    expect(res.closedThreads).toBe(1)
    expect(t.support_threads.map((r) => r.id)).toEqual(["t-null"])
  })

  it("does not delete or count a thread that reopened between select and delete", async () => {
    const t: Tables = {
      support_threads: [thread("t-1", "closed", 100), thread("t-2", "closed", 100)],
      support_messages: [],
      complaints: [],
    }
    let flipped = false
    const fake = sim(t, [], (table, tb) => {
      if (table === "support_threads" && !flipped) {
        flipped = true
        tb.support_threads.find((r) => r.id === "t-1")!.status = "open"
      }
    })
    const res = await deleteOldSupportData(fake.db as any, NOW)
    expect(t.support_threads.map((r) => r.id)).toEqual(["t-1"])
    expect(res.closedThreads).toBe(1)
    const del = fake.calls.find((c) => c.table === "support_threads" && c.op === "delete")!
    expect(del.filters).toContainEqual(["status", "closed"])
    expect(del.filters.some(([k]) => k === "closed_at:lt")).toBe(true)
  })

  it("does not delete or count a complaint that went back to pending between select and delete", async () => {
    const t: Tables = {
      support_threads: [],
      support_messages: [],
      complaints: [complaint("c-1", "resolved", 100), complaint("c-2", "resolved", 100)],
    }
    let flipped = false
    const fake = sim(t, [], (table, tb) => {
      if (table === "complaints" && !flipped) {
        flipped = true
        tb.complaints.find((r) => r.id === "c-1")!.status = "pending"
      }
    })
    const res = await deleteOldSupportData(fake.db as any, NOW)
    expect(t.complaints.map((r) => r.id)).toEqual(["c-1"])
    expect(res.legacyComplaints).toBe(1)
    const del = fake.calls.find((c) => c.table === "complaints" && c.op === "delete")!
    expect(del.filters).toContainEqual(["status:in", ["resolved", "rejected"]])
    expect(del.filters.some(([k]) => k === "updated_at:lt")).toBe(true)
  })

  it("terminates when a guarded delete removes fewer rows than were selected", async () => {
    const t: Tables = {
      support_threads: Array.from({ length: 450 }, (_, i) => thread(`t-${pad(i)}`, "closed", 100)),
      support_messages: [],
      complaints: [],
    }
    let flipped = false
    const fake = sim(t, [], (table, tb) => {
      if (table === "support_threads" && !flipped) {
        flipped = true
        tb.support_threads[0].status = "open"
      }
    })
    const res = await deleteOldSupportData(fake.db as any, NOW)
    expect(res.closedThreads).toBe(449)
    expect(t.support_threads.map((r) => r.id)).toEqual(["t-0000"])
    expect(fake.calls.filter((c) => c.table === "support_threads" && c.op === "select").length).toBeLessThanOrEqual(4)
  })

  it("still deletes rows when file removal reports nothing (helper never throws)", async () => {
    const t: Tables = {
      support_threads: [],
      support_messages: [],
      complaints: [complaint("c-1", "resolved", 100, { balance_image_path: "u/b.jpg" })],
    }
    const res = await deleteOldSupportData(sim(t).db as any, NOW)
    expect(res.legacyComplaints).toBe(1)
    expect(t.complaints).toHaveLength(0)
  })
})
