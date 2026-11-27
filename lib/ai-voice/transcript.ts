// Builds a running transcript from Nuance Live interface events. Pure, no I/O.

export interface Turn {
  role: "user" | "assistant"
  content: string
  eventId?: string
}

type Ev = { type: string } & Record<string, unknown>

export class CallTranscript {
  private items: Turn[] = []
  private pending = ""

  onEvent(ev: Ev): void {
    switch (ev.type) {
      case "session.input_transcript.done": {
        const text = typeof ev.transcript === "string" ? ev.transcript.trim() : ""
        const eventId = typeof ev.event_id === "string" ? ev.event_id : undefined
        const replaces = typeof ev.replaces_event_id === "string" ? ev.replaces_event_id : undefined
        if (replaces) {
          const idx = this.items.findIndex((t) => t.role === "user" && t.eventId === replaces)
          if (idx >= 0) {
            if (text) this.items[idx] = { role: "user", content: text, eventId }
            else this.items.splice(idx, 1)
            return
          }
        }
        if (text) this.items.push({ role: "user", content: text, eventId })
        return
      }
      case "session.output_transcript.delta":
        if (typeof ev.delta === "string") this.pending += ev.delta
        return
      case "session.output_audio.done": {
        const text = this.pending.trim()
        this.pending = ""
        if (text) this.items.push({ role: "assistant", content: text })
        return
      }
      default:
        return
    }
  }

  turns(): Turn[] {
    return this.items.map((t) => ({ ...t }))
  }

  captions(): Turn[] {
    const out = this.turns()
    const text = this.pending.trim()
    if (text) out.push({ role: "assistant", content: text })
    return out
  }
}
