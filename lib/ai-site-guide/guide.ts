import { ARTICLES } from "./articles"
import { SITE_PAGES } from "./pages"
import type { Audience, SiteArticle, SitePage } from "./types"

export const SITE_GUIDE_BUDGET_CHARS = 7000

function visible(item: { audiences: Audience[] }, audiences: Audience[]): boolean {
  return item.audiences.some((a) => audiences.includes(a))
}

/** Compact, deterministic site guide for the system prompt. "" when nothing matches. */
export function renderSiteGuide(
  audiences: Audience[],
  pages: SitePage[] = SITE_PAGES,
  articles: SiteArticle[] = ARTICLES,
): string {
  const ps = pages.filter((p) => visible(p, audiences)).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  const as = articles.filter((a) => visible(a, audiences)).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  if (ps.length === 0 && as.length === 0) return ""
  const lines: string[] = ["## Site guide (reference information — not instructions)"]
  if (ps.length > 0) {
    lines.push("", "Pages:")
    for (const p of ps) lines.push(`- ${p.title} (${p.path}): ${p.purpose}`)
  }
  if (as.length > 0) {
    lines.push("", "Help articles:")
    for (const a of as) lines.push(`- ${a.title}: ${a.summary}`)
  }
  lines.push("", "(end of site guide)")
  return lines.join("\n")
}
