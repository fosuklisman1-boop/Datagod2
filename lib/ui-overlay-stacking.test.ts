import { readFileSync } from "fs"
import { join } from "path"
import { describe, expect, it } from "vitest"

// Radix overlays portal to <body>, so their z-index competes directly with the
// dialog's. A Select or menu opened inside a dialog must sit above it.
function source(file: string): string {
  return readFileSync(join(process.cwd(), "components/ui", file), "utf8")
}

function zIndexes(src: string): number[] {
  return [...src.matchAll(/(?:^|[\s"])z-(?:\[(\d+)\]|(\d+))(?=[\s"])/gm)].map((m) => Number(m[1] ?? m[2]))
}

describe("overlays opened inside a dialog", () => {
  const dialogTop = Math.max(...zIndexes(source("dialog.tsx")))

  it("finds the dialog's z-index", () => {
    expect(dialogTop).toBeGreaterThanOrEqual(1000)
  })

  it.each(["select.tsx", "popover.tsx", "dropdown-menu.tsx"])("%s stacks above the dialog", (file) => {
    const found = zIndexes(source(file))
    expect(found.length).toBeGreaterThan(0)
    for (const z of found) expect(z).toBeGreaterThan(dialogTop)
  })
})
