// Client helpers for AI chat transcripts. Fire-and-forget: a failed ping must never affect the chat.

/** A fresh per-chat-session key, or null where crypto.randomUUID is unavailable (the server then makes one per request). */
export function newConversationKey(): string | null {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID() : null
}

/** Tells the server a chat hit a handoff press or an error so it can flag the stored conversation. */
export function pingConversationEvent(key: string | null | undefined, event: "handoff" | "error"): void {
  if (!key) return
  try {
    void fetch("/api/ai/conversation-events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationKey: key, event }),
      keepalive: true,
    }).catch(() => {})
  } catch {
    // ignore
  }
}
