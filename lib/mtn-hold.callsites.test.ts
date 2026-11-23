import { describe, it, expect } from "vitest"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"

// Every holdMtnOrder( call must pass errorType (and strictReason) from the
// createMTNOrder response, so a STRICT_HOLD gets a strict hold record and the
// strict SMS instead of the registration SMS.

const ROOT = join(__dirname, "..")

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) out.push(p)
  }
  return out
}

/** The argument text of a call starting at the "(" at index i (balanced parens). */
function callArgs(src: string, i: number): string {
  let depth = 0
  for (let j = i; j < src.length; j++) {
    if (src[j] === "(") depth++
    else if (src[j] === ")") {
      depth--
      if (depth === 0) return src.slice(i + 1, j)
    }
  }
  return src.slice(i + 1)
}

describe("holdMtnOrder call sites", () => {
  it("every call passes errorType and strictReason", () => {
    const calls: { file: string; args: string }[] = []
    for (const file of [...walk(join(ROOT, "lib")), ...walk(join(ROOT, "app"))]) {
      const src = readFileSync(file, "utf8")
      const re = /holdMtnOrder\(/g
      let m: RegExpExecArray | null
      while ((m = re.exec(src))) {
        const before = src.slice(Math.max(0, m.index - 30), m.index)
        if (/function\s+$/.test(before)) continue // the definition
        const args = callArgs(src, m.index + "holdMtnOrder".length)
        if (/^\s*p\s*:/.test(args)) continue // an interface method signature
        calls.push({ file: relative(ROOT, file).replace(/\\/g, "/"), args })
      }
    }
    // 9 order paths + the v2 deps' real implementation.
    expect(calls.length).toBeGreaterThanOrEqual(10)
    const missing = calls.filter((c) => !/errorType/.test(c.args) || !/strictReason/.test(c.args)).map((c) => c.file)
    expect(missing).toEqual([])
  }, 60_000) // walks every source file under lib/ and app/
})
