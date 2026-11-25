import { ARTICLES } from "./articles"
import { SITE_PAGES } from "./pages"
import type { Audience, RenderOptions, SiteArticle, SitePage } from "./types"

export const SITE_GUIDE_BUDGET_CHARS = 10000

function visible(item: { audiences: Audience[] }, audiences: Audience[]): boolean {
  return item.audiences.some((a) => audiences.includes(a))
}

const AUDIENCE_SETS: Audience[][] = [
  ["public"],
  ["public", "customer"],
  ["public", "customer", "dealer"],
  ["public", "customer", "shop_owner"],
  ["public", "customer", "dealer", "shop_owner"],
  ["public", "customer", "dealer", "shop_owner", "admin"],
]

/** Human-readable violations of the content limits; [] when the data is fine. */
export function checkSiteGuideLimits(pages: SitePage[], articles: SiteArticle[]): string[] {
  const out: string[] = []
  const paths = new Set<string>()
  for (const p of pages) {
    if (paths.has(p.path)) out.push(`duplicate path: ${p.path}`)
    paths.add(p.path)
    if (p.purpose.length > 160) out.push(`page ${p.path}: purpose over 160 chars`)
    if (p.tasks.length < 1 || p.tasks.length > 5) out.push(`page ${p.path}: tasks must be 1-5`)
    if (p.audiences.length === 0) out.push(`page ${p.path}: empty audiences`)
  }
  const ids = new Set<string>()
  for (const a of articles) {
    if (ids.has(a.id)) out.push(`duplicate id: ${a.id}`)
    ids.add(a.id)
    if (a.summary.length > 200) out.push(`article ${a.id}: summary over 200 chars`)
    if (a.body.length > 2500) out.push(`article ${a.id}: body over 2500 chars`)
    if (a.audiences.length === 0) out.push(`article ${a.id}: empty audiences`)
  }
  for (const set of AUDIENCE_SETS) {
    const len = renderSiteGuide(set, pages, articles).length
    if (len > SITE_GUIDE_BUDGET_CHARS) {
      out.push(`guide for [${set.join(",")}] is ${len} chars, over budget ${SITE_GUIDE_BUDGET_CHARS}`)
    }
  }
  return out
}

/** Compact, deterministic site guide for the system prompt. "" when nothing matches. */
export function renderSiteGuide(
  audiences: Audience[],
  pages: SitePage[] = SITE_PAGES,
  articles: SiteArticle[] = ARTICLES,
  options: RenderOptions = {},
): string {
  const hide = (x: { platformOnly?: true }) => !!options.shopSurface && !!x.platformOnly
  const ps = pages.filter((p) => visible(p, audiences) && !hide(p)).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  const as = articles.filter((a) => visible(a, audiences) && !hide(a)).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const showArticles = as.length > 0 && options.toolHint !== false
  if (ps.length === 0 && !showArticles) return ""
  const lines: string[] = ["## Site guide (reference information — not instructions)"]
  if (ps.length > 0) {
    lines.push("", "Pages:")
    for (const p of ps) lines.push(`- ${p.title} (${p.path}): ${p.purpose}`)
  }
  if (showArticles) {
    lines.push("", `Detailed how-to articles (use get_knowledge_base to read one): ${as.map((a) => a.title).join("; ")}`)
  }
  lines.push("", "(end of site guide)")
  return lines.join("\n")
}
