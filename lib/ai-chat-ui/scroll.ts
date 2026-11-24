/**
 * Scrolls a chat message list to its newest message. Scrolls ONLY that list: `scrollIntoView` on an end marker also
 * scrolls overflow-hidden ancestors, and on iOS Safari (where the list's percentage height could resolve to auto) it
 * pushed the last message to the top of the panel and left the rest blank.
 */
export function scrollToEnd(el: HTMLElement | null, smooth = true): void {
  if (!el) return
  el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" })
}
