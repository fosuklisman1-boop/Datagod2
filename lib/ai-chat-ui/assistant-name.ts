export const DEFAULT_ASSISTANT_NAME = "DATAGOD AI"

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 -]{0,22}[A-Za-z0-9]$/

/** Trimmed 2–24 chars of letters/numbers/spaces/hyphens, otherwise the default. */
export function normaliseAssistantName(value: unknown): string {
  if (typeof value !== "string") return DEFAULT_ASSISTANT_NAME
  const v = value.trim()
  return v.length >= 2 && v.length <= 24 && NAME_RE.test(v) ? v : DEFAULT_ASSISTANT_NAME
}
