import { describe, it, expect, vi } from "vitest"
import { collectAllPages } from "./collect-pages"

const make = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `u${i + 1}` }))

describe("collectAllPages", () => {
  it("pages until total is reached", async () => {
    const all = make(5)
    const fetchPage = vi.fn(async (page: number) => ({ users: all.slice((page - 1) * 2, page * 2), total: 5 }))
    const progress: number[] = []
    const out = await collectAllPages(fetchPage, { pageSize: 2, onProgress: (n) => progress.push(n) })
    expect(out.map((u) => u.id)).toEqual(["u1", "u2", "u3", "u4", "u5"])
    expect(fetchPage).toHaveBeenCalledTimes(3)
    expect(progress).toEqual([2, 4, 5])
  })

  it("stops on an exact multiple without an extra empty request", async () => {
    const all = make(4)
    const fetchPage = vi.fn(async (page: number) => ({ users: all.slice((page - 1) * 2, page * 2), total: 4 }))
    await collectAllPages(fetchPage, { pageSize: 2 })
    expect(fetchPage).toHaveBeenCalledTimes(2)
  })

  it("drops a row repeated across a page boundary (signup during export)", async () => {
    const pages = [[{ id: "a" }, { id: "b" }], [{ id: "b" }, { id: "c" }], [{ id: "d" }]]
    const out = await collectAllPages(async (p) => ({ users: pages[p - 1] ?? [], total: 5 }), { pageSize: 2 })
    expect(out.map((u) => u.id)).toEqual(["a", "b", "c", "d"])
  })

  it("stops on an empty page and on maxPages", async () => {
    const empty = vi.fn(async () => ({ users: [], total: 100 }))
    expect(await collectAllPages(empty, { pageSize: 2 })).toEqual([])
    expect(empty).toHaveBeenCalledTimes(1)
    let n = 0
    const endless = vi.fn(async () => ({ users: [{ id: `x${n++}` }, { id: `x${n++}` }], total: 1e9 }))
    await collectAllPages(endless, { pageSize: 2, maxPages: 3 })
    expect(endless).toHaveBeenCalledTimes(3)
  })

  it("propagates errors", async () => {
    await expect(collectAllPages(async () => { throw new Error("boom") }, { pageSize: 2 })).rejects.toThrow("boom")
  })
})
