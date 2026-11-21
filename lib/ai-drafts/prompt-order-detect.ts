// Heuristic used by scripts/pause-prompt-order-tasks.ts to spot legacy scheduled AI tasks that
// order data through a typed prompt (these stop working once the cron AI loses ordering tools).

const ORDER_VERB = /\b(?:buy|order|send|purchase|top ?up)\b/i
const DATA_MARKER = /\d+\s*(?:gb|mb)\b|\bdata\b|\bbundles?\b/i
// "order" used as a noun for reporting, not as a verb to place one.
const ORDER_REPORT_PHRASE = /\b(?:my\s+orders?|orders?\s+(?:status|history)|order\s+(?:status|history))\b/gi

export function looksLikeOrderPrompt(prompt: string): boolean {
  if (!prompt) return false
  const text = prompt.replace(ORDER_REPORT_PHRASE, " ")
  return ORDER_VERB.test(text) && DATA_MARKER.test(prompt)
}
