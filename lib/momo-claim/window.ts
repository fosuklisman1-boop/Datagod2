export const WINDOW_MINUTES = 60
export const MAX_OPEN_SESSIONS = 5

export type SessionLite = {
  id: string
  status: string
  createdAt: string
  expiresAt: string
}

/** Pending and unexpired sessions, newest first. */
export function openSessions(sessions: SessionLite[], now: Date): SessionLite[] {
  const t = now.getTime()
  return sessions
    .filter((s) => s.status === "pending" && new Date(s.expiresAt).getTime() > t)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
}

/** When the next slot frees up; null if fewer than MAX_OPEN_SESSIONS are open. */
export function nextSlotFreeAt(sessions: SessionLite[], now: Date): Date | null {
  const open = openSessions(sessions, now)
  if (open.length < MAX_OPEN_SESSIONS) return null
  const earliest = Math.min(...open.map((s) => new Date(s.expiresAt).getTime()))
  return new Date(earliest)
}
