import type { NextRequest } from "next/server"
import { applyRateLimit } from "@/lib/rate-limiter"

export type SupportLimitKind = "thread_create" | "message_send"

const LIMITS: Record<SupportLimitKind, { max: number; windowMs: number }> = {
  thread_create: { max: 3, windowMs: 3_600_000 },
  message_send: { max: 10, windowMs: 60_000 },
}

// Per-instance fallback used only when the shared limiter is degraded (Redis
// missing or erroring). Bounded: expired timestamps are dropped on every check
// and empty keys are deleted.
const memory = new Map<string, number[]>()

function memoryAllows(kind: SupportLimitKind, userId: string): boolean {
  const { max, windowMs } = LIMITS[kind]
  const key = `${kind}:${userId}`
  const now = Date.now()
  const live = (memory.get(key) ?? []).filter((t) => now - t < windowMs)
  if (live.length >= max) {
    memory.set(key, live)
    return false
  }
  live.push(now)
  memory.set(key, live)
  return true
}

function sweepExpired(): void {
  const now = Date.now()
  for (const [key, stamps] of memory) {
    const kind = key.slice(0, key.indexOf(":")) as SupportLimitKind
    const windowMs = LIMITS[kind]?.windowMs ?? 0
    const live = stamps.filter((t) => now - t < windowMs)
    if (live.length === 0) memory.delete(key)
    else if (live.length !== stamps.length) memory.set(key, live)
  }
}

/**
 * Fail-closed wrapper: the shared limiter fails open when Redis is down, which
 * would leave support unthrottled. When it reports `degraded` (or throws) we
 * ignore its verdict and enforce the same limits from memory.
 */
export async function checkSupportRateLimit(
  request: NextRequest,
  kind: SupportLimitKind,
  userId: string,
): Promise<{ allowed: boolean }> {
  const { max, windowMs } = LIMITS[kind]
  let result: { allowed?: unknown; degraded?: unknown } | null = null
  try {
    result = await applyRateLimit(request, `support_${kind}`, max, windowMs, userId)
  } catch (e) {
    console.error("[SUPPORT] rate limiter threw, using memory fallback", { kind })
  }
  // Trust the shared verdict only when it explicitly says it is healthy and gives a real boolean.
  if (result && result.degraded === false && typeof result.allowed === "boolean") return { allowed: result.allowed }
  sweepExpired()
  return { allowed: memoryAllows(kind, userId) }
}

export function __resetSupportRateLimitMemory(): void {
  memory.clear()
}
