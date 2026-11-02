// Browser side of the users export: follow GET /api/admin/users/export's cursor
// until it is done, retrying rate limits, and fail loudly rather than return a
// partial list.

export class UsersExportError extends Error {
  /** Users fetched before it stopped. */
  readonly loaded: number
  constructor(message: string, loaded: number) {
    super(message)
    this.name = "UsersExportError"
    this.loaded = loaded
  }
}

/** How long to wait before retrying a 429: Retry-After, else X-RateLimit-Reset, else 1s * 2^attempt. 0.5s..60s. */
export function retryDelayMs(headers: Pick<Headers, "get">, attempt: number, nowMs: number = Date.now()): number {
  const clamp = (ms: number) => Math.min(Math.max(Math.round(ms), 500), 60_000)
  const retryAfter = Number(headers.get("Retry-After"))
  if (headers.get("Retry-After") && Number.isFinite(retryAfter)) return clamp(retryAfter * 1000)
  const reset = Date.parse(headers.get("X-RateLimit-Reset") ?? "")
  if (Number.isFinite(reset)) return clamp(reset - nowMs)
  return clamp(1000 * 2 ** attempt)
}

export interface ExportOptions {
  onProgress?: (loaded: number) => void
  sleep?: (ms: number) => Promise<void>
  /** 429 retries allowed per chunk. */
  maxRetries?: number
  /** Safety stop. 200 chunks of 5000 = 1M users; going past it is an error, never a silent cut. */
  maxChunks?: number
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/**
 * fetchChunk(cursor) must request one export chunk (cursor null = start) and return the Response.
 * Resolves with every user, or rejects with UsersExportError.
 */
export async function exportAllUsers<T extends { id: string }>(
  fetchChunk: (cursor: string | null) => Promise<Response>,
  opts: ExportOptions = {},
): Promise<T[]> {
  const sleep = opts.sleep ?? defaultSleep
  const maxRetries = opts.maxRetries ?? 5
  const maxChunks = opts.maxChunks ?? 200
  const out: T[] = []
  const seen = new Set<string>()
  let cursor: string | null = null

  for (let chunk = 0; ; chunk++) {
    if (chunk >= maxChunks) {
      throw new UsersExportError(`Export stopped after more than ${maxChunks} requests (${out.length} users)`, out.length)
    }

    let res: Response | null = null
    for (let attempt = 0; ; attempt++) {
      try {
        res = await fetchChunk(cursor)
      } catch (e) {
        throw new UsersExportError(`Export failed after ${out.length} users: ${e instanceof Error ? e.message : String(e)}`, out.length)
      }
      if (res.status !== 429) break
      if (attempt >= maxRetries) {
        throw new UsersExportError(`Export stopped after ${out.length} users: still rate limited after ${maxRetries} retries`, out.length)
      }
      await sleep(retryDelayMs(res.headers, attempt))
    }

    const body = await res.json().catch(() => null)
    if (!res.ok || !body || !Array.isArray(body.users)) {
      const reason = body?.error || `HTTP ${res.status}`
      throw new UsersExportError(`Export failed after ${out.length} users: ${reason}`, out.length)
    }

    for (const u of body.users as T[]) {
      if (seen.has(u.id)) continue
      seen.add(u.id)
      out.push(u)
    }
    opts.onProgress?.(out.length)

    const next: string | null = body.nextCursor ?? null
    if (next === null) return out
    if (next === cursor) {
      throw new UsersExportError(`Export stopped after ${out.length} users: the cursor did not advance`, out.length)
    }
    cursor = next
  }
}
