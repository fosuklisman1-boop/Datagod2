/**
 * Builds the "reload from the top" action. It reads the params through `getParams` at call
 * time, so a long-lived callback (e.g. the batch-progress poll) never reloads a stale view.
 */
export function makeQueueReloader<P>(
  getParams: () => P,
  load: (params: P, append: boolean) => unknown,
  clearSelection: () => void,
): () => void {
  return () => {
    clearSelection()
    load(getParams(), false)
  }
}
