import { describe, it, expect } from "vitest"
import { deleteOldConversations, RETENTION_DAYS } from "./retention"

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
