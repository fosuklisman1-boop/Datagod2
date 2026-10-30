// Source-level a11y pin for components/standard-bundles/StandardBundlesPage.tsx (components/ is outside the vitest
// include and the repo has no DOM test setup): the Network role="tablist" may only own tabs, so the non-tab
// "Telecel Broadband" placeholder tile inside it must be role="presentation".
import { describe, expect, it } from "vitest"
import { readFileSync } from "fs"
import path from "path"

const SRC = readFileSync(path.join(process.cwd(), "components/standard-bundles/StandardBundlesPage.tsx"), "utf8")

describe("StandardBundlesPage network tablist", () => {
  it("the Telecel Broadband placeholder tile is role=presentation, not a bare child of the tablist", () => {
    const start = SRC.indexOf('role="tablist" aria-label="Network"')
    expect(start).toBeGreaterThan(-1)
    const marker = SRC.indexOf("Telecel Broadband: not sold", start)
    expect(marker).toBeGreaterThan(start)
    const tileOpen = SRC.slice(marker, SRC.indexOf(">", SRC.indexOf("<div", marker)) + 1)
    expect(tileOpen).toContain('role="presentation"')
  })
})
