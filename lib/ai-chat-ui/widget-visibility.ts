import type { Audiences } from "@/lib/ai-console/settings"

export type WidgetKind = "home" | "storefront" | "dashboard" | "admin"

const AUDIENCE_FOR_WIDGET: Record<WidgetKind, keyof Audiences> = {
  home: "publicVisitors",
  storefront: "shopVisitors",
  dashboard: "signedIn",
  admin: "admins",
}

/** A widget is shown unless its audience is switched off. Unknown audiences (still loading) = shown, so nothing flashes. */
export function widgetVisible(widget: WidgetKind, audiences: Audiences | null | undefined): boolean {
  if (!audiences) return true
  return audiences[AUDIENCE_FOR_WIDGET[widget]] !== false
}

export const ASSISTANT_OFF_MESSAGE = "The assistant is switched off right now."

/** True when the chat route answered 403 { error: "assistant_off" } (settings changed mid-session). */
export async function isAssistantOffResponse(res: { status: number; clone: () => { json: () => Promise<unknown> } }): Promise<boolean> {
  if (res.status !== 403) return false
  try {
    const j = (await res.clone().json()) as { error?: unknown } | null
    return j?.error === "assistant_off"
  } catch {
    return false
  }
}

/** The "switched off" bubble. isError keeps it out of saved history, the history sent to the API and follow-up chips. */
export function assistantOffMessage(now: number = Date.now()) {
  return { role: "assistant" as const, content: ASSISTANT_OFF_MESSAGE, timestamp: now, isError: true as const }
}
