import { describe, it, expect } from "vitest"
import { deleteOldConversations, deleteOldVoiceCalls, deleteOldVoiceQueue, RETENTION_DAYS } from "./retention"

describe("voice waiting-line retention", () => {
  function fakeQueueDb(rows: Array<{ id: string; created_at: string }>, fail = false) {
    const seen = { table: "", cutoff: "", column: "" }
    return {
      rows,
      seen,
      from(t: string) {
        seen.table = t
        let cutoff = ""
        const q: any = {
          delete: () => q,
          lt: (c: string, v: string) => { seen.column = c; cutoff = v; return q },
          then: (res: any, rej: any) => {
            if (fail) return Promise.resolve({ count: null, error: { message: "db down" } }).then(res, rej)
            seen.cutoff = cutoff
            const before = rows.length
            for (let i = rows.length - 1; i >= 0; i--) if (rows[i].created_at < cutoff) rows.splice(i, 1)
            return Promise.resolve({ count: before - rows.length, error: null }).then(res, rej)
          },
        }
        return q
      },
    }
  }
  const NOW3 = new Date("2026-12-31T12:00:00Z")
  it("deletes ai_voice_queue rows older than 1 day and keeps newer ones", async () => {
    const db = fakeQueueDb([
      { id: "old", created_at: "2026-12-30T11:00:00Z" },
      { id: "recent", created_at: "2026-12-31T00:00:00Z" },
    ])
    expect(await deleteOldVoiceQueue(db as any, NOW3)).toBe(1)
    expect(db.rows.map((r) => r.id)).toEqual(["recent"])
    expect(db.seen).toMatchObject({ table: "ai_voice_queue", column: "created_at" })
    expect(new Date(db.seen.cutoff).getTime()).toBe(NOW3.getTime() - 24 * 60 * 60 * 1000)
  })
  it("throws when the delete fails", async () => {
    await expect(deleteOldVoiceQueue(fakeQueueDb([], true) as any, NOW3)).rejects.toThrow()
  })
})

function fakeVoiceDb(rows: Array<{ id: string; created_at: string }>, fail = false) {
  const seen = { cutoff: "" }
  return {
    rows,
    seen,
    from() {
      let cutoff = ""
      let del = false
      const q: any = {
        delete: () => { del = true; return q },
        lt: (_c: string, v: string) => { cutoff = v; return q },
        then: (res: any, rej: any) => {
          let out: any
          if (fail) out = { data: null, count: null, error: { message: "db down" } }
          else if (del) {
            seen.cutoff = cutoff
            const before = rows.length
            for (let i = rows.length - 1; i >= 0; i--) if (rows[i].created_at < cutoff) rows.splice(i, 1)
            out = { data: null, count: before - rows.length, error: null }
          } else out = { data: null, count: null, error: null }
          return Promise.resolve(out).then(res, rej)
        },
      }
      return q
    },
  }
}

describe("voice call retention", () => {
  it("deletes ai_voice_calls older than 30 days and keeps newer ones", async () => {
    const NOW2 = new Date("2026-12-31T00:00:00Z")
    const db = fakeVoiceDb([
      { id: "old1", created_at: "2026-11-01T00:00:00Z" },
      { id: "old2", created_at: "2026-11-20T00:00:00Z" },
      { id: "recent1", created_at: "2026-12-05T00:00:00Z" },
    ])
    const n = await deleteOldVoiceCalls(db as any, NOW2)
    expect(n).toBe(2)
    expect(db.rows.map((r) => r.id)).toEqual(["recent1"])
    expect(new Date(db.seen.cutoff).getTime()).toBe(NOW2.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000)
  })
  it("throws when the delete fails", async () => {
    await expect(deleteOldVoiceCalls(fakeVoiceDb([], true) as any, NOW)).rejects.toThrow()
  })
})

const NOW = new Date("2026-12-31T00:00:00Z")
function fakeDb(rows: Array<{ id: string; last_at: string }>) {
  const deletes: string[][] = []
  return {
    rows,
    deletes,
    from() {
      let cutoff = ""
      let lim = 1e9
      let del = false
      let ids: string[] = []
      const q: any = {
        select: () => q,
        lt: (_c: string, v: string) => { cutoff = v; return q },
        limit: (n: number) => { lim = n; return q },
        delete: () => { del = true; return q },
        in: (_c: string, v: string[]) => { ids = v; return q },
        then: (res: any, rej: any) => {
          let out: any
          if (del) {
            deletes.push(ids)
            ids.forEach((i) => { const k = rows.findIndex((r) => r.id === i); if (k >= 0) rows.splice(k, 1) })
            out = { data: null, error: null }
          } else {
            out = { data: rows.filter((r) => r.last_at < cutoff).slice(0, lim).map((r) => ({ id: r.id })), error: null }
          }
          return Promise.resolve(out).then(res, rej)
        },
      }
      return q
    },
  }
}

describe("retention", () => {
  it("retention_deletes_older_than_30_days_in_chunks", async () => {
    expect(RETENTION_DAYS).toBe(30)
    const old = Array.from({ length: 1203 }, (_, i) => ({ id: `o${i}`, last_at: "2026-11-01T00:00:00Z" }))
    const edge = [{ id: "recent1", last_at: "2026-12-05T00:00:00Z" }, { id: "recent2", last_at: "2026-12-31T00:00:00Z" }]
    const db = fakeDb([...old, ...edge])
    const n = await deleteOldConversations(db as any, NOW)
    expect(n).toBe(1203)
    expect(db.deletes.length).toBeGreaterThanOrEqual(3)
    expect(Math.max(...db.deletes.map((d) => d.length))).toBeLessThanOrEqual(500)
    expect(db.rows.map((r) => r.id).sort()).toEqual(["recent1", "recent2"])
  })
})
