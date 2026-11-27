// Relays Nuance Live persona hand-offs to the Clings chat and sends a masked
// answer back. Framework-agnostic: link, relay and transcript are injected.
// Everything sent to Nuance is plain ASCII English and passes clampForAppend.

import { clampForAppend } from "./mask"
import type { CallTranscript, Turn } from "./transcript"

export interface ChatRelay {
  ask(history: Turn[]): Promise<{ text: string; cards: Array<{ id: string; summary: string }> }>
}
export interface LiveLink {
  send(ev: Record<string, unknown>): Promise<void>
  connected(): boolean
}

export const CARD_COMMENTARY =
  "I've put a card on your screen with the details. Please check it and tap Confirm if it's right."
export const FAILURE_COMMENTARY =
  "I couldn't get that done right now. Please try again, or use the text chat."

const OUTCOME_TEXT = {
  confirmed: "The customer confirmed the card:",
  cancelled: "The customer cancelled the card:",
  already_placed: "That card was already placed:",
  failed: "The card could not be completed:",
} as const

type Ev = { type: string } & Record<string, unknown>

export function createCallSession(deps: {
  link: LiveLink
  relay: ChatRelay
  transcript: CallTranscript
  timeoutMs?: number
}) {
  const { link, relay, transcript } = deps
  const timeoutMs = deps.timeoutMs ?? 45000

  async function safeSend(ev: Record<string, unknown>): Promise<void> {
    try {
      await link.send(ev)
    } catch {
      // Call dropped; never crash the page.
    }
  }

  async function answer(): Promise<string> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("relay timeout")), timeoutMs)
      })
      const res = await Promise.race([relay.ask(transcript.turns()), timeout])
      if (res.cards.length > 0) return CARD_COMMENTARY + " " + res.cards[0].summary
      return res.text
    } catch {
      return FAILURE_COMMENTARY
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  async function onInterfaceEvent(ev: Ev): Promise<void> {
    try {
      if (ev.type !== "session.delegation.created") return
      const d = ev.delegation as { id?: unknown; target?: unknown } | undefined
      if (!d || d.target !== "client" || typeof d.id !== "string") return
      await safeSend({
        type: "session.thinking.append",
        delegation_id: d.id,
        content: "Checking...",
      })
      const text = await answer()
      await safeSend({
        type: "session.commentary.append",
        delegation_id: d.id,
        content: clampForAppend(text),
      })
    } catch {
      // Never throw out of the event handler.
    }
  }

  async function onCardOutcome(o: {
    summary: string
    outcome: "confirmed" | "cancelled" | "already_placed" | "failed"
  }): Promise<void> {
    try {
      if (!link.connected()) return
      await safeSend({
        type: "session.thinking.append",
        delegation_id: null,
        content: clampForAppend(`${OUTCOME_TEXT[o.outcome]} ${o.summary}`),
        while_speaking: "finish",
      })
    } catch {
      // ignore
    }
  }

  return { onInterfaceEvent, onCardOutcome }
}
