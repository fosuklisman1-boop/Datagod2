// Relays a voice hand-off to the existing /api/ai/chat route and reads its SSE stream into { text, cards }.
// Same request body and event shapes the text widgets use; no new server surface.
import type { ChatRelay } from "./call-session"
import type { Turn } from "./transcript"

export interface RelayCard {
  id: string
  summary: string
  display: unknown
  expires_at: string
  warnings: string[]
}

const MAX_TURNS = 10

/** One short line for a card (title + its amount-ish line); it is masked before it reaches Nuance. */
export function summariseCard(display: unknown): string {
  const d = (display && typeof display === "object" ? display : {}) as Record<string, unknown>
  const title = typeof d.title === "string" && d.title.trim() ? d.title.trim() : "Confirm action"
  const lines = Array.isArray(d.lines)
    ? (d.lines as unknown[])
        .filter((l): l is { label: unknown; value: unknown } => !!l && typeof l === "object")
        .map((l) => ({ label: String(l.label ?? "").trim(), value: String(l.value ?? "").trim() }))
        .filter((l) => l.label && l.value)
    : []
  const line = lines.find((l) => /amount|total|price|cost/i.test(l.label)) ?? lines[0]
  return line ? `${title}. ${line.label} ${line.value}` : title
}

export function createChatRelay(opts: {
  context: string
  shopSlug?: string
  authHeader?: () => Promise<string | undefined>
  fetchImpl?: typeof fetch
  conversationKey?: () => string | null
  /** Called with the full card data so the widget can render usable DraftCards. */
  onCards?: (cards: RelayCard[]) => void
}): ChatRelay {
  const doFetch = opts.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a))
  return {
    async ask(history: Turn[]) {
      const headers: Record<string, string> = { "Content-Type": "application/json" }
      const auth = opts.authHeader ? await opts.authHeader() : undefined
      if (auth) headers.Authorization = auth
      const key = opts.conversationKey?.()
      const res = await doFetch("/api/ai/chat", {
        method: "POST",
        headers,
        body: JSON.stringify({
          messages: history.slice(-MAX_TURNS).map((t) => ({ role: t.role, content: t.content })),
          context: opts.context,
          ...(opts.shopSlug ? { shopSlug: opts.shopSlug } : {}),
          ...(key ? { conversationKey: key } : {}),
        }),
      })
      if (!res.ok || !res.body) throw new Error(`chat relay failed (${res.status})`)

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""
      let text = ""
      let failed = false
      const cards: RelayCard[] = []
      const handle = (part: string) => {
        const line = part.startsWith("data: ") ? part.slice(6) : part
        if (!line) return
        let ev: Record<string, unknown>
        try { ev = JSON.parse(line) } catch { return }
        if (ev.type === "text" && typeof ev.content === "string") text += ev.content
        else if (ev.type === "error") failed = true
        else if (ev.type === "draft_card" && typeof ev.draft_id === "string") {
          cards.push({
            id: ev.draft_id,
            summary: summariseCard(ev.display),
            display: ev.display,
            expires_at: String(ev.expires_at ?? ""),
            warnings: Array.isArray(ev.warnings) ? (ev.warnings as string[]) : [],
          })
        }
      }
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const parts = buffer.split("\n\n")
        buffer = parts.pop() ?? ""
        parts.forEach(handle)
      }
      if (buffer) handle(buffer)
      if (failed) throw new Error("chat relay stream error")
      if (cards.length > 0) opts.onCards?.(cards)
      return { text, cards: cards.map((c) => ({ id: c.id, summary: c.summary })) }
    },
  }
}
