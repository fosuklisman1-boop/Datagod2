/**
 * Shared SEO copy rules, used by the registry tests and the guides tests so the
 * regexes and limits live in one place. Pure.
 */
export const BANNED_COPY = /instant|in seconds|automatic(ally)? refund/i

export const TITLE_SUFFIX = "| DATAGOD"
export const TITLE_MAX = 60
export const DESCRIPTION_MIN = 120
export const DESCRIPTION_MAX = 160

/** Human-readable problems with a title/description pair; empty when compliant. */
export function metaProblems(title: string, description: string): string[] {
  const out: string[] = []
  if (title.length > TITLE_MAX) out.push(`title longer than ${TITLE_MAX} (${title.length})`)
  if (!title.endsWith(TITLE_SUFFIX)) out.push(`title must end with "${TITLE_SUFFIX}"`)
  if (description.length < DESCRIPTION_MIN || description.length > DESCRIPTION_MAX) {
    out.push(`description must be ${DESCRIPTION_MIN}-${DESCRIPTION_MAX} chars (${description.length})`)
  }
  return out
}
