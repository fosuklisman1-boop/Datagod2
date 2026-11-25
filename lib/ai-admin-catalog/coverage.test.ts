import { describe, it, expect } from "vitest"
import path from "node:path"
import { scanAdminRoutes } from "./routes-scan"
import { CATALOG, getEntry, searchEntries } from "./index"
import { EXCLUDED } from "./excluded"
import { PENDING, PENDING_BUDGET } from "./pending"
import type { CatalogEntry } from "./types"

const ROOT = path.resolve(__dirname, "../..")
const scanned = scanAdminRoutes(ROOT)
const key = (method: string, p: string) => `${method} ${p}`
const scannedKeys = new Set(scanned.map((r) => key(r.method, r.path)))
const catalogKeys = CATALOG.map((e) => key(e.method, e.path))
const excludedKeys = EXCLUDED.map((e) => key(e.method, e.path))

describe("route coverage", () => {
  it("scans a plausible number of routes", () => {
    expect(scanned.length).toBeGreaterThan(300)
    expect(scanned.some((r) => r.path.includes(":"))).toBe(true)
  })

  it("every scanned route+method is in exactly one list", () => {
    const bad: string[] = []
    for (const k of scannedKeys) {
      const n =
        Number(catalogKeys.includes(k)) + Number(excludedKeys.includes(k)) + Number(PENDING.includes(k))
      if (n !== 1) bad.push(`${k} (in ${n})`)
    }
    expect(bad).toEqual([])
  })

  it("no stale rows in any list", () => {
    expect(catalogKeys.filter((k) => !scannedKeys.has(k))).toEqual([])
    expect(excludedKeys.filter((k) => !scannedKeys.has(k))).toEqual([])
    expect(PENDING.filter((k) => !scannedKeys.has(k))).toEqual([])
  })

  it("lists have no duplicates", () => {
    expect(new Set(catalogKeys).size).toBe(catalogKeys.length)
    expect(new Set(excludedKeys).size).toBe(excludedKeys.length)
    expect(new Set(PENDING).size).toBe(PENDING.length)
    const ids = CATALOG.map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("PENDING is sorted, within budget, and every exclusion has a reason", () => {
    expect([...PENDING].sort()).toEqual(PENDING)
    expect(PENDING.length).toBeLessThanOrEqual(PENDING_BUDGET)
    expect(EXCLUDED.filter((e) => !e.reason.trim())).toEqual([])
  })
})

describe("catalog entry rules", () => {
  it("lookups keep results; changes have a card", () => {
    for (const e of CATALOG) {
      if (e.kind === "lookup") expect(e.resultKeep?.length, e.id).toBeGreaterThan(0)
      if (e.kind === "change") expect(Boolean(e.card || e.typedCard), e.id).toBe(true)
    }
  })

  it("timeouts are capped", () => {
    for (const e of CATALOG) {
      if (e.timeoutMs !== undefined) expect(e.timeoutMs, e.id).toBeLessThanOrEqual(60000)
    }
  })

  it("secret fields never appear in body shape", () => {
    for (const e of CATALOG) {
      for (const s of e.secretFields ?? []) {
        expect(Object.keys(e.body?.shape ?? {}), e.id).not.toContain(s.name)
      }
    }
  })

  it("declared params match :name segments in path", () => {
    for (const e of CATALOG) {
      const declared = Object.keys(e.params ?? {}).sort()
      const inPath = e.path
        .split("/")
        .filter((s) => s.startsWith(":"))
        .map((s) => s.slice(1))
        .sort()
      expect(declared, e.id).toEqual(inPath)
    }
  })
})

describe("searchEntries", () => {
  const mk = (id: string, page: string, summary: string): CatalogEntry =>
    ({
      id,
      page,
      pageTitle: `Title ${page}`,
      summary,
      area: "a",
      method: "GET",
      path: "/api/admin/x",
      kind: "lookup",
      risk: "normal",
      auth: "admin",
    }) as CatalogEntry
  const list = [
    mk("orders.list", "orders", "List Orders"),
    mk("users.find", "users", "Find a user"),
    mk("orders.get", "orders", "One order"),
  ]

  it("matches tokens case-insensitively and ANDs them", () => {
    expect(searchEntries(list, "LIST orders").map((e) => e.id)).toEqual(["orders.list"])
    expect(searchEntries(list, "order").map((e) => e.id)).toEqual(["orders.list", "orders.get"])
  })
  it("filters by page and honours limit", () => {
    expect(searchEntries(list, "", "users").map((e) => e.id)).toEqual(["users.find"])
    expect(searchEntries(list, "order", undefined, 1)).toHaveLength(1)
  })
  it("returns [] for no match; unknown id is undefined", () => {
    expect(searchEntries(list, "zzz")).toEqual([])
    expect(getEntry("nope")).toBeUndefined()
  })
})
