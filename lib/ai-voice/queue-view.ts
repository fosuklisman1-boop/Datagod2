// Wording and numbers for the waiting-line screen. Pure, so they are tested without React.

export function ordinal(n: number): string {
  const tens = n % 100
  if (tens >= 11 && tens <= 13) return `${n}th`
  switch (n % 10) {
    case 1: return `${n}st`
    case 2: return `${n}nd`
    case 3: return `${n}rd`
    default: return `${n}th`
  }
}

export function queueEtaLabel(etaSeconds: number): string {
  return `About ${Math.max(1, Math.ceil(etaSeconds / 60))} min`
}

export function queueHeading(position: number, etaSeconds: number): string {
  return `You're ${ordinal(position)} in line · ${queueEtaLabel(etaSeconds)}`
}

/** Bar fill 5..95: how far the caller has moved up from where they joined (`startPosition`). Never claims done. */
export function queueProgress(startPosition: number, position: number): number {
  const start = Math.max(1, startPosition)
  const moved = Math.max(0, start - position + 1)
  return Math.min(95, Math.max(5, Math.round((100 * moved) / (start + 1))))
}
