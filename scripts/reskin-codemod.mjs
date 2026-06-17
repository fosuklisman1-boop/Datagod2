// scripts/reskin-codemod.mjs — safe accent-family codemod for the emerald reskin.
// Replaces purple/violet/indigo/fuchsia/cyan utility colors with `primary`, and
// bg-white -> bg-card. Does NOT touch status families (green/red/yellow/amber/orange)
// or network colors — those need human judgment (network-color collisions).
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { join, extname } from 'node:path'

const ROOTS = ['app', 'components']
const EXCLUDE_DIRS = ['app/api', 'node_modules', '.next']
const EXCLUDE_FILES = ['app/page.tsx', 'app/globals.css'] // page.tsx done in Plan 1
const EXT = new Set(['.tsx', '.ts', '.jsx', '.js'])
const ACCENTS = 'purple|violet|indigo|fuchsia|cyan'
// utility prefixes that take a color-shade
const PREFIX = 'bg|text|border|ring|from|to|via|fill|stroke|divide|outline|shadow|ring-offset|placeholder|decoration|accent|caret'

let filesChanged = 0
const report = [] // remaining off-token occurrences to hand-fix later

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (EXCLUDE_DIRS.some((d) => p.replaceAll('\\', '/').startsWith(d))) continue
    const st = statSync(p)
    if (st.isDirectory()) walk(p)
    else if (EXT.has(extname(p)) && !EXCLUDE_FILES.includes(p.replaceAll('\\', '/'))) transform(p)
  }
}

function transform(file) {
  let src = readFileSync(file, 'utf8')
  const before = src
  // 1) accent families -> primary (drop the numeric shade and any /opacity stays)
  src = src.replace(
    new RegExp(`\\b(${PREFIX})-(?:${ACCENTS})-(\\d{2,3})(/\\d{1,3})?\\b`, 'g'),
    (_m, pfx, _shade, op) => `${pfx}-primary${op ?? ''}`
  )
  // 2) bg-white -> bg-card ; bg-black -> bg-background (leave text-white for review)
  src = src.replace(/\bbg-white\b/g, 'bg-card').replace(/\bbg-black\b/g, 'bg-background')
  if (src !== before) { writeFileSync(file, src); filesChanged++ }

  // 3) report remaining debt for later tasks (status families, text-white, hex, gradients)
  const rel = file.replaceAll('\\', '/')
  const status = (src.match(/\b(?:bg|text|border|ring|from|to|via)-(?:green|red|yellow|amber|orange|slate|gray)-\d{2,3}\b/g) || [])
  const white = (src.match(/\btext-white\b/g) || [])
  const hex = (src.match(/#[0-9a-fA-F]{6}\b/g) || [])
  if (status.length || white.length || hex.length) {
    report.push(`${rel}: status=${status.length} text-white=${white.length} hex=${hex.length}`)
  }
}

ROOTS.forEach(walk)
console.log(`\n[reskin-codemod] files changed: ${filesChanged}`)
console.log(`[reskin-codemod] files with remaining debt (status/white/hex): ${report.length}`)
report.sort().forEach((r) => console.log('  ' + r))
