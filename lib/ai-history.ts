export interface HistoryMsg {
  role: "user" | "assistant"
  content: string
}

/**
 * Make a chat history valid for every provider: starts with a user turn, alternates roles, ends with a user turn.
 * Empty/whitespace turns are dropped, consecutive same-role turns are merged ("\n\n"), leading assistant turns and
 * a trailing assistant turn are dropped. Nothing usable left -> [].
 */
export function normaliseHistory(msgs: HistoryMsg[]): HistoryMsg[] {
  const out: HistoryMsg[] = []
  for (const m of msgs) {
    if (!m.content.trim()) continue
    if (out.length === 0 && m.role === "assistant") continue
    const last = out[out.length - 1]
    if (last && last.role === m.role) last.content = `${last.content}\n\n${m.content}`
    else out.push({ role: m.role, content: m.content })
  }
  while (out.length > 0 && out[out.length - 1].role === "assistant") out.pop()
  return out
}
