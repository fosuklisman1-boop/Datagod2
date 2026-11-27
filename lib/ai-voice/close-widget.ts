// Every way of closing a chat widget goes through here so a live call can never be left running with no panel.
export type CloseSource = "button" | "escape" | "backdrop"

export function closeWidgetDuringCall(o: { callActive: boolean; source: CloseSource; hangUp: () => void; close: () => void }): void {
  if (!o.callActive) {
    o.close()
    return
  }
  // A stray tap outside the dialog must not drop a call.
  if (o.source === "backdrop") return
  o.hangUp()
  o.close()
}
