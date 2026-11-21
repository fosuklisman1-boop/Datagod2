/** Fires onTimeout if reset() is not called for `ms`. Starts running immediately; clear() stops it for good. */
export function createIdleTimeout(ms: number, onTimeout: () => void): { reset: () => void; clear: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null
  let done = false
  const arm = () => {
    if (timer) clearTimeout(timer)
    timer = done ? null : setTimeout(onTimeout, ms)
  }
  arm()
  return {
    reset: arm,
    clear: () => {
      done = true
      if (timer) clearTimeout(timer)
      timer = null
    },
  }
}
