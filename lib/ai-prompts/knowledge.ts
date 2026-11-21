import type { SupabaseClient } from "@supabase/supabase-js"

export const KNOWLEDGE_BUDGET_CHARS = 12000
export const KNOWLEDGE_CACHE_MS = 60_000

/** Added to the stable prefix, right before the knowledge section, only when a section is injected. */
export const KNOWLEDGE_RULE_LINE = "Answer policy questions from the Knowledge base section when it covers them; otherwise use get_knowledge_base."

export interface KnowledgeEntry {
  category: string
  question: string
  answer: string
}

export type KnowledgeLabel = "storefront" | "dashboard" | "admin"

/**
 * Same labels the get_knowledge_base tool filters on (admin → 'admin', signed-in → 'dashboard', else 'storefront').
 * Web chat: home and storefront are guest contexts → 'storefront'.
 */
export function knowledgeLabelFor(context: "home" | "storefront" | "dashboard" | "admin"): KnowledgeLabel {
  if (context === "admin") return "admin"
  if (context === "dashboard") return "dashboard"
  return "storefront"
}

const cache = new Map<string, { ts: number; entries: KnowledgeEntry[] }>()

/** Test hook. */
export function resetKnowledgeCache(): void {
  cache.clear()
}

/**
 * Active ai_knowledge entries for a label, cached 60 s per label. Any read problem returns [] (the model then falls
 * back to the get_knowledge_base tool) and logs a fixed marker only: no error text, no row content. Failures are
 * not cached.
 */
export async function loadKnowledge(db: Pick<SupabaseClient, "from">, label: KnowledgeLabel): Promise<KnowledgeEntry[]> {
  const hit = cache.get(label)
  if (hit && Date.now() - hit.ts < KNOWLEDGE_CACHE_MS) return hit.entries
  try {
    const { data, error } = await db
      .from("ai_knowledge")
      .select("category, question, answer")
      .eq("is_active", true)
      .contains("contexts", [label])
    if (error) throw new Error("read failed")
    const rows = Array.isArray(data) ? data : []
    const entries = rows.filter(
      (r): r is KnowledgeEntry =>
        !!r && typeof r.category === "string" && typeof r.question === "string" && typeof r.answer === "string",
    )
    cache.set(label, { ts: Date.now(), entries })
    return entries
  } catch {
    console.warn("[AI-KNOWLEDGE] could not load knowledge base")
    return []
  }
}

/** Appends the rule line + section at the very end of a stable prefix; no-op for an empty section. */
export function appendKnowledge(stable: string, knowledge: string | undefined): string {
  return knowledge ? `${stable}\n\n${KNOWLEDGE_RULE_LINE}\n\n${knowledge}` : stable
}

const byText =(a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/**
 * Whole entries, sorted by category then question (deterministic bytes for the cache), as one section. If the full
 * text would exceed the budget nothing is injected: never a partial knowledge base.
 */
export function renderKnowledge(entries: KnowledgeEntry[], budget: number = KNOWLEDGE_BUDGET_CHARS): string {
  if (entries.length === 0) return ""
  const body = [...entries]
    .sort((a, b) => byText(a.category, b.category) || byText(a.question, b.question) || byText(a.answer, b.answer))
    .map((e) => `### ${e.category}\nQ: ${e.question}\nA: ${e.answer}`)
    .join("\n\n")
  const text = `## Knowledge base\n${body}`
  return text.length > budget ? "" : text
}
