// After a call ends the captions become ordinary chat messages and any cards stay usable under the last reply.
import type { Turn } from "./transcript"
import type { RelayCard } from "./chat-relay"

export interface CallChatMessage {
  role: "user" | "assistant"
  content: string
  timestamp: number
  cards?: Array<{ draftId: string; display: unknown; expires_at: string; warnings: string[] }>
}

export function callToMessages(turns: Turn[], cards: RelayCard[], now: number): CallChatMessage[] {
  const out: CallChatMessage[] = turns.map((t) => ({ role: t.role, content: t.content, timestamp: now }))
  if (cards.length === 0) return out
  const attached = cards.map((c) => ({ draftId: c.id, display: c.display, expires_at: c.expires_at, warnings: c.warnings }))
  const last = out[out.length - 1]
  if (last && last.role === "assistant") last.cards = attached
  else out.push({ role: "assistant", content: "Please check the details below.", timestamp: now, cards: attached })
  return out
}
