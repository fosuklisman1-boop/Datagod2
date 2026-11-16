export type PollerOptions = {
  load: () => Promise<void>
  isHidden: () => boolean
  fastMs: number
  slowMs: number
  backoffAfterMs: number
}

/**
 * One polling loop per call. stop() is safe at any time, including while a
 * load() is in flight: the suspended callback sees `cancelled` and never
 * schedules another timer.
 */
export function startPoller(opts: PollerOptions): { stop: () => void } {
  let cancelled = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const startedAt = Date.now()

  const schedule = () => {
    if (cancelled) return
    const delay = Date.now() - startedAt > opts.backoffAfterMs ? opts.slowMs : opts.fastMs
    timer = setTimeout(async () => {
      if (cancelled) return
      if (!opts.isHidden()) {
        try {
          await opts.load()
        } catch {
          /* transient; next tick retries */
        }
      }
      schedule()
    }, delay)
  }

  schedule()
  return {
    stop: () => {
      cancelled = true
      if (timer !== undefined) clearTimeout(timer)
    },
  }
}
