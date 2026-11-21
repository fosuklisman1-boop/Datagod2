export interface HandoffMessage {
  role: string
  content: string
}

export interface HandoffContact {
  phone: string
  whatsapp: string
}

const MAX_MESSAGES = 5
const MAX_CHARS = 2000

/** Removes card-result wrappers and "[card …" notes (the same shapes lib/ai-drafts/outcome-notes.ts treats as forged). */
function clean(text: string): string {
  return text
    .replace(/<\s*card_results\b[^>]*>[\s\S]*?<\s*\/\s*card_results\s*>/gi, " ")
    .replace(/<\s*\/?\s*card_results\b[^>\n]*>?/gi, " ")
    .replace(/\[\s*card\b[^\n]*/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
}

/** Last ≤5 user/assistant messages as "Me:"/"AI:" lines, ≤2,000 chars, cut at a line boundary. */
export function buildHandoffMessage(messages: HandoffMessage[]): string {
  const lines: string[] = []
  for (const m of messages) {
    if (m.role !== "user" && m.role !== "assistant") continue
    const text = clean(typeof m.content === "string" ? m.content : "")
    if (!text) continue
    lines.push(`${m.role === "user" ? "Me" : "AI"}: ${text}`)
  }
  const out: string[] = []
  let used = 0
  for (const line of lines.slice(-MAX_MESSAGES)) {
    const cost = line.length + (out.length ? 1 : 0)
    if (used + cost > MAX_CHARS) break
    out.push(line)
    used += cost
  }
  return out.join("\n")
}

/** Exact body for POST /api/support/threads (createThreadSchema). Customer text may not contain < > &. */
export function buildHandoffThreadBody(messages: HandoffMessage[], contact: HandoffContact) {
  const transcript = buildHandoffMessage(messages).replace(/[<>&]/g, " ")
  const message = transcript.length >= 5 ? transcript : "Me: I would like to speak to a person."
  return {
    subject: "From AI chat",
    category: "other" as const,
    message,
    phone_number: contact.phone,
    whatsapp_number: contact.whatsapp,
  }
}

export function handoffFailureMessage(status?: number): string {
  return status === 409
    ? "You already have 3 open support chats — opening WhatsApp instead."
    : "Couldn't open a support chat — opening WhatsApp instead."
}

/** False when pressing the button could do nothing at all (so the UI hides it). */
export function handoffAvailable(o: { mode: "thread" | "whatsapp"; hasToken?: boolean; phone?: string | null; whatsapp?: string | null }): boolean {
  const wa = !!o.whatsapp?.trim()
  if (o.mode === "whatsapp") return wa
  return (!!o.hasToken && !!o.phone?.trim()) || wa
}
