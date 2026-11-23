import { v2DocsRegistry, type V2DocSection } from "./registry"
import { DOC_PAGES, STATIC_DOC_PAGES, docPath, endpointHref, sectionHref } from "./pages"
import { errorAnchor, errorCode } from "./error-key"

export type SearchKind = "page" | "section" | "endpoint" | "error"
export interface SearchEntry {
  kind: SearchKind
  title: string
  detail: string
  href: string
  keywords: string
}

const KIND_ORDER: Record<SearchKind, number> = { endpoint: 0, section: 1, page: 2, error: 3 }

export function buildSearchIndex(registry: V2DocSection[] = v2DocsRegistry): SearchEntry[] {
  const out: SearchEntry[] = []
  for (const p of [...DOC_PAGES, ...STATIC_DOC_PAGES]) {
    out.push({ kind: "page", title: p.title, detail: p.description, href: docPath(p.slug), keywords: p.description })
  }
  const seenErrors = new Set<string>()
  for (const s of registry) {
    const intro = (s.intro ?? "").slice(0, 200)
    out.push({ kind: "section", title: s.label, detail: intro, href: sectionHref(s.id), keywords: `${s.label} ${intro}` })
    for (const e of s.endpoints) {
      out.push({
        kind: "endpoint",
        title: `${e.method} ${e.path}`,
        detail: e.summary,
        href: endpointHref(registry, e.id),
        keywords: [e.method, e.path, e.summary, ...e.params.map((p) => p.name)].join(" "),
      })
      for (const err of e.errors) {
        const anchor = errorAnchor(err.status, err.message)
        if (seenErrors.has(anchor)) continue
        seenErrors.add(anchor)
        out.push({
          kind: "error",
          title: `${err.status} ${errorCode(err.message) ?? err.message}`,
          detail: err.message,
          href: `/developers/errors#${anchor}`,
          keywords: `${err.status} ${err.message}`,
        })
      }
    }
  }
  return out
}

// Title word or path-segment match 4, title prefix 3, title substring 2, keyword hit 1.
function tokenScore(entry: SearchEntry, token: string): number {
  const title = entry.title.toLowerCase()
  const words = title.split(/[\s/]+/).filter(Boolean)
  if (title === token || words.includes(token) || title.includes(`/${token}`)) return 4
  if (title.startsWith(token) || words.some((w) => w.startsWith(token))) return 3
  if (title.includes(token)) return 2
  if (entry.keywords.toLowerCase().includes(token)) return 1
  return 0
}

export function searchDocs(index: readonly SearchEntry[], query: string, limit = 12): SearchEntry[] {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return []
  const scored: { entry: SearchEntry; score: number; i: number }[] = []
  index.forEach((entry, i) => {
    let score = 0
    for (const t of tokens) {
      const s = tokenScore(entry, t)
      if (s === 0) return
      score += s
    }
    scored.push({ entry, score, i })
  })
  scored.sort((a, b) => b.score - a.score || KIND_ORDER[a.entry.kind] - KIND_ORDER[b.entry.kind] || a.i - b.i)
  return scored.slice(0, Math.max(0, limit)).map((s) => s.entry)
}

export function shouldHijackSlash(e: {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  target: { tagName?: string; isContentEditable?: boolean } | null
}): boolean {
  if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey) return false
  const t = e.target
  if (!t) return true
  if (t.isContentEditable) return false
  const tag = (t.tagName ?? "").toUpperCase()
  return tag !== "INPUT" && tag !== "TEXTAREA" && tag !== "SELECT"
}
