/**
 * Last-started-wins guard for async loads: take a ticket before starting, and apply the
 * result only if no newer ticket was taken in the meantime.
 */
export interface LatestGate {
  next(): number
  isLatest(ticket: number): boolean
}

export function createLatestGate(): LatestGate {
  let current = 0
  return {
    next: () => ++current,
    isLatest: (ticket: number) => ticket === current,
  }
}
