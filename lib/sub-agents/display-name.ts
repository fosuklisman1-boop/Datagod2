// Built from a string so the line separators stay escaped (raw U+2028/U+2029 would end a regex literal).
const CONTROL_CHARS = new RegExp("[\\u0000-\\u001f\\u007f\\u2028\\u2029]+", "g")

/** Untrusted display name (typed on a public form): control chars/newlines become spaces, trimmed, max 40 chars. */
export function cleanDisplayName(s: string): string {
  return String(s ?? "").replace(CONTROL_CHARS, " ").trim().slice(0, 40)
}
