import { ARTICLES } from "./articles"
import type { Audience, SiteArticle } from "./types"

const STOPWORDS = new Set([
  "a", "an", "the", "i", "my", "me", "how", "do", "to", "go", "is", "can", "what", "where", "please", "pls",
])

function stem(word: string): string {
  let w = word
  if (w.length - 2 >= 3 && /(x|ch|sh|ss)es$/.test(w)) w = w.slice(0, -2)
  else if (w.length - 1 >= 3 && w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1)
  if (w.endsWith("ing") && w.length - 3 >= 3) w = w.slice(0, -3)
  else if (w.endsWith("ed") && w.length - 2 >= 3) w = w.slice(0, -2)
  return w
}

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0 && !STOPWORDS.has(t))
    .map(stem)
}

/**
 * Distinct stemmed search tokens of a free-text query (same tokenizer as searchSite), at most `max`.
 * Every token is [a-z0-9] only, so it is safe to put inside an ILIKE pattern.
 */
export function queryTokens(query: string, max = 6): string[] {
  return Array.from(new Set(tokens(query))).slice(0, max)
}

/** Keyword search over help articles the audience may see. Best match first, ties by id. */
export function searchSite(
  query: string,
  audiences: Audience[],
  limit = 5,
  articles: SiteArticle[] = ARTICLES,
): SiteArticle[] {
  const q = Array.from(new Set(tokens(query)))
  if (q.length === 0) return []
  const scored: { a: SiteArticle; score: number }[] = []
  for (const a of articles) {
    if (!a.audiences.some((x) => audiences.includes(x))) continue
    const title = new Set(tokens(a.title))
    const kw = new Set(a.keywords.flatMap(tokens))
    const summary = new Set(tokens(a.summary))
    const body = new Set(tokens(a.body))
    let score = 0
    for (const t of q) {
      if (title.has(t)) score += 4
      if (kw.has(t)) score += 3
      if (summary.has(t)) score += 2
      if (body.has(t)) score += 1
    }
    if (score > 0) scored.push({ a, score })
  }
  scored.sort((x, y) => y.score - x.score || (x.a.id < y.a.id ? -1 : x.a.id > y.a.id ? 1 : 0))
  return scored.slice(0, limit).map((s) => s.a)
}
