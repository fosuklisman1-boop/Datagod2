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
  // Rule B — keep ghost buttons readable on hover (text-primary immediately before hover)
  src = src.replace(/text-primary hover:bg-primary(?![/\w-])/g, 'text-primary hover:bg-primary/20')
  // Rule C — non-adjacent emerald-on-emerald: a solid hover:bg-primary on a button whose
  // text is/turns emerald (text-primary / hover:text-primary) would hide the label on hover;
  // and one chip with text-primary + solid bg-primary on the same element. Targeted, exact.
  const LITERAL = [
    ['rounded-md hover:bg-primary transition-colors', 'rounded-md hover:bg-primary/10 transition-colors'],
    ['hover:bg-primary text-foreground hover:text-primary rounded-xl', 'hover:bg-primary/10 text-foreground hover:text-primary rounded-xl'],
    ['hover:bg-primary text-foreground hover:text-primary rounded-lg', 'hover:bg-primary/10 text-foreground hover:text-primary rounded-lg'],
    ['text-primary border-primary hover:bg-primary"', 'text-primary border-primary hover:bg-primary/10"'],
    ['text-primary font-semibold text-xs bg-primary rounded-lg', 'text-primary font-semibold text-xs bg-primary/10 rounded-lg'],
    // Emerald icons inside a SOLID bg-primary circle/square (invisible). The MoMo "awaiting"
    // spinner (w-8 h-8) lives only inside bg-primary circles; the admin Bot sits in a bg-primary square.
    ['w-8 h-8 text-primary animate-spin', 'w-8 h-8 text-primary-foreground animate-spin'],
    ['<Bot size={22} className="text-primary" />', '<Bot size={22} className="text-primary-foreground" />'],
  ]
  for (const [a, b] of LITERAL) src = src.split(a).join(b)
  // Rule D — light-tint CARDS collapsed to solid color. Signature: a solid bg-{primary|status}
  // on an element that ALSO has a neutral `border-border` (real buttons never pair a loud solid
  // fill with a neutral border). Such cards lost their tint, hiding their neutral/colored text.
  // Restore the tint -> bg-{color}/10. Line-scoped + excludes buttons (text-*-foreground / text-white).
  src = src
    .split('\n')
    .map((line) => {
      if (!line.includes('border-border')) return line
      if (/text-(?:primary|success|warning|destructive)-foreground|text-white/.test(line)) return line
      return line.replace(/bg-(primary|success|warning|destructive)\b(?!\/)/g, 'bg-$1/10')
    })
    .join('\n')
  if (src !== before) {
    writeFileSync(file, src)
    filesChanged++
    changed.push(file.replaceAll('\\', '/'))
  }
}

ROOTS.forEach(walk)
console.log(`[fix-invisible-emerald] files changed: ${filesChanged}`)
changed.sort().forEach((f) => console.log('  ' + f))
