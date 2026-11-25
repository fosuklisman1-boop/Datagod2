import { describe, it, expect } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { ADMIN_PAGES, pageTitleFor } from "./pages"
import { CATALOG } from "./index"

const ADMIN_DIR = path.resolve(__dirname, "../../app/admin")

function discoverPaths(dir: string, urlParts: string[] = []): string[] {
  const out: string[] = []
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.isDirectory()) {
      const name = ent.name
      const part = /^\(.*\)$/.test(name) ? null : name.replace(/^\[(.+)\]$/, ":$1")
      out.push(...discoverPaths(path.join(dir, name), part ? [...urlParts, part] : urlParts))
    } else if (ent.name === "page.tsx") {
      out.push("/admin" + (urlParts.length ? "/" + urlParts.join("/") : ""))
    }
  }
  return out
}

describe("admin page guide", () => {
  const onDisk = discoverPaths(ADMIN_DIR)

  it("finds a plausible number of pages on disk", () => {
    expect(onDisk.length).toBeGreaterThan(40)
  })

  it("has exactly one entry for every admin page", () => {
    const listed = ADMIN_PAGES.map((p) => p.path)
    expect(new Set(listed).size).toBe(listed.length)
    expect([...listed].sort()).toEqual([...onDisk].sort())
  })

  it("keeps purpose short and tasks between 1 and 5", () => {
    for (const p of ADMIN_PAGES) {
      expect(p.title.trim().length, p.path).toBeGreaterThan(0)
      expect(p.purpose.length, p.path).toBeGreaterThan(0)
      expect(p.purpose.length, p.path).toBeLessThanOrEqual(160)
      expect(p.tasks.length, p.path).toBeGreaterThanOrEqual(1)
      expect(p.tasks.length, p.path).toBeLessThanOrEqual(5)
      for (const t of p.tasks) expect(t.trim().length, p.path).toBeGreaterThan(0)
    }
  })

  it("every catalog entry points at a guided page", () => {
    const paths = new Set(ADMIN_PAGES.map((p) => p.path))
    for (const e of CATALOG) expect(paths.has(e.page), e.id).toBe(true)
  })

  it("pageTitleFor returns the title or undefined", () => {
    expect(pageTitleFor("/admin/orders")).toBe(ADMIN_PAGES.find((p) => p.path === "/admin/orders")?.title)
    expect(pageTitleFor("/admin/orders")).toBeTruthy()
    expect(pageTitleFor("/admin/nope")).toBeUndefined()
  })
})
