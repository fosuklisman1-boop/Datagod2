// scripts/fix-invisible-emerald.mjs
// Fixes invisible emerald-on-emerald text introduced by the reskin codemod:
// tinted chips like `bg-blue-100 text-blue-800` were collapsed to
// `bg-primary text-primary` (solid emerald bg + solid emerald text = invisible).
// Rule A: `bg-primary text-primary` (NOT `text-primary-foreground`) -> `bg-primary/10 text-primary`
//         (10% emerald-tint background keeps the emerald text readable in both themes).
// Rule B: `text-primary hover:bg-primary` (solid hover would re-hide the text) -> `hover:bg-primary/20`.
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { join, extname } from 'node:path'

const ROOTS = ['app', 'components']
const EXCLUDE_DIRS = ['app/api', 'node_modules', '.next']
const EXT = new Set(['.tsx', '.ts', '.jsx', '.js'])

let filesChanged = 0
const changed = []

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (EXCLUDE_DIRS.some((d) => p.replaceAll('\\', '/').startsWith(d))) continue
    const st = statSync(p)
    if (st.isDirectory()) walk(p)
    else if (EXT.has(extname(p))) transform(p)
  }
}

function transform(file) {
  let src = readFileSync(file, 'utf8')
  const before = src
  // Rule A — restore contrast (skip text-primary-foreground via negative lookahead)
  src = src.replace(/bg-primary text-primary(?!-)/g, 'bg-primary/10 text-primary')
  // Rule B — keep ghost buttons readable on hover
  src = src.replace(/text-primary hover:bg-primary(?![/\w-])/g, 'text-primary hover:bg-primary/20')
  if (src !== before) {
    writeFileSync(file, src)
    filesChanged++
    changed.push(file.replaceAll('\\', '/'))
  }
}

ROOTS.forEach(walk)
console.log(`[fix-invisible-emerald] files changed: ${filesChanged}`)
changed.sort().forEach((f) => console.log('  ' + f))
