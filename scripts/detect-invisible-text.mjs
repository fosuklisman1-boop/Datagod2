// scripts/detect-invisible-text.mjs
// Flags elements whose TEXT color is the same color-family AND similar lightness as its
// background (own element = high confidence; inherited from a parent = medium). Shade-aware:
// a light bg (e.g. green-100) with dark text (green-700) is READABLE and not flagged.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, extname } from 'node:path'

const ROOTS = ['app', 'components']
const EXCLUDE = ['app/api', 'node_modules', '.next']
const EXT = new Set(['.tsx', '.jsx'])

function family(tok) {
  if (/^(primary|success|emerald|green|lime|teal)$/.test(tok)) return 'green'
  if (/^(destructive|red|rose)$/.test(tok)) return 'red'
  if (/^(warning|amber|yellow|orange)$/.test(tok)) return 'amber'
  if (/^(brand-accent|blue|sky|cyan|indigo|violet|purple|fuchsia)$/.test(tok)) return 'blue'
  if (/^(muted|secondary|accent|card|popover|background|sidebar|input|border)$/.test(tok)) return 'neutral'
  if (/^(gray|slate|zinc|neutral|stone)$/.test(tok)) return 'neutral'
  return null // foreground/white/black (contrast colors) and unknown -> ignore as text
}
// approximate lightness rank from a tailwind shade (lower number = lighter). Design tokens
// (no number) sit mid (~600). Our emerald `primary` token is bright, treat as ~500.
function shade(numStr, tok) {
  if (numStr) return parseInt(numStr, 10)
  return tok === 'primary' ? 500 : 600
}

// Returns the element's own { bg:{fam,sh}, text:{fam,sh} } from one className blob.
function classesOf(blob) {
  let bg = null, text = null
  for (const m of blob.matchAll(/(?:^|[\s"'`{(])bg-([a-z][a-z-]*?)(-\d{2,3})?(?![\w/-])/g)) {
    const f = family(m[1])
    if (f && f !== 'neutral') bg = { fam: f, sh: shade(m[2] && m[2].slice(1), m[1]) }
  }
  for (const m of blob.matchAll(/(?:^|[\s"'`{(])text-([a-z][a-z-]*?)(-\d{2,3})?(?![\w/-])/g)) {
    const f = family(m[1])
    if (f) text = { fam: f, sh: shade(m[2] && m[2].slice(1), m[1]) }
  }
  return { bg, text }
}

const invisible = (a, b) => a && b && a.fam === b.fam && Math.abs(a.sh - b.sh) <= 250

const high = [], med = []

function scan(file) {
  const lines = readFileSync(file, 'utf8').split('\n')
  const stack = [{ bg: null }]
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const cm = line.match(/className=(?:"([^"]*)"|\{`([^`]*)`\}|\{cn\(([\s\S]*?)\)\}|\{([^}]*)\})/)
    const blob = cm ? (cm[1] || cm[2] || cm[3] || cm[4] || '') : ''
    const own = classesOf(blob)
    const parentBg = stack[stack.length - 1].bg
    const effBg = own.bg || parentBg
    if (own.text) {
      const loc = `${file.replaceAll('\\', '/')}:${i + 1}`
      if (own.bg && invisible(own.bg, own.text)) high.push(`${loc}  text-${own.text.fam}${own.text.sh} on SAME-EL bg-${own.bg.fam}${own.bg.sh}  | ${blob.slice(0, 95)}`)
      else if (parentBg && invisible(parentBg, own.text)) med.push(`${loc}  text-${own.text.fam}${own.text.sh} on parent bg-${parentBg.fam}${parentBg.sh}  | ${blob.slice(0, 90)}`)
    }
    const opens = (line.match(/<[A-Za-z][^>]*?(?<!\/)>/g) || []).length
    const selfClose = (line.match(/\/>/g) || []).length
    const closes = (line.match(/<\/[A-Za-z]/g) || []).length
    if (opens > selfClose && own.bg) stack.push({ bg: own.bg })
    for (let c = 0; c < closes; c++) if (stack.length > 1) stack.pop()
  }
}

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (EXCLUDE.some((d) => p.replaceAll('\\', '/').startsWith(d))) continue
    const st = statSync(p)
    if (st.isDirectory()) walk(p)
    else if (EXT.has(extname(p))) scan(p)
  }
}

ROOTS.forEach(walk)
console.log(`\n=== HIGH confidence (same element, same color, similar lightness): ${high.length} ===`)
high.forEach((f) => console.log('  ' + f))
console.log(`\n=== MEDIUM (text same color as a PARENT background): ${med.length} ===`)
med.forEach((f) => console.log('  ' + f))
