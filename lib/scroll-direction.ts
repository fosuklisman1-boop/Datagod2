export type NavVisibilityInput = {
  visible: boolean
  /** Scroll position at the last decision (the anchor movement is measured from). */
  anchorY: number
  currentY: number
  /** Minimum travel in px from the anchor before the direction counts. */
  threshold: number
  /** At or below this scroll position the nav is always visible. */
  topOffset: number
  /** False when the page does not overflow: nav is always visible. */
  scrollable: boolean
}

/**
 * Decide whether a bottom nav should be visible after a scroll event.
 * Returns the new visibility and the new anchor position. Movement smaller
 * than `threshold` from the anchor is ignored (anchor kept), so jitter does
 * not toggle the nav while slow same-direction scrolling still accumulates.
 */
export function nextNavVisible(input: NavVisibilityInput): { visible: boolean; anchorY: number } {
  const { visible, anchorY, currentY, threshold, topOffset, scrollable } = input
  if (!scrollable || currentY <= topOffset) return { visible: true, anchorY: currentY }
  const delta = currentY - anchorY
  if (Math.abs(delta) < threshold) return { visible, anchorY }
  return { visible: delta < 0, anchorY: currentY }
}
