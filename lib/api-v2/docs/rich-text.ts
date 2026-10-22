/**
 * Code-like tokens in registry prose that read better as inline monospace chips:
 * JSON shapes (one level of nesting), header names, key prefixes and URLs.
 * Longer alternatives come first so "Authorization: Bearer <key>" wins over "Authorization".
 */
const CODE_TOKEN =
  /(\{(?:[^{}]|\{[^{}]*\})*\}|Authorization: Bearer <key>|Authorization|X-API-Key|dg2_(?:live|test)_|https:\/\/[^\s,]+)/g

/** Sentence punctuation that may follow a URL in prose but is not part of it. */
const URL_TRAILING = /[.)\]!?;:'"]+$/

export interface RichTextPart {
  code: boolean
  text: string
}

/** Splits prose into plain and code parts; concatenating every part's text gives back the input. */
export function splitRichText(input: string): RichTextPart[] {
  const out: RichTextPart[] = []
  const push = (code: boolean, text: string) => {
    if (text) out.push({ code, text })
  }
  input.split(CODE_TOKEN).forEach((part, i) => {
    if (i % 2 === 0) return push(false, part)
    const tail = part.startsWith("https://") ? (part.match(URL_TRAILING)?.[0] ?? "") : ""
    push(true, part.slice(0, part.length - tail.length))
    push(false, tail)
  })
  // Merge adjacent plain parts (a stripped URL tail followed by the next plain run).
  return out.reduce<RichTextPart[]>((acc, p) => {
    const last = acc[acc.length - 1]
    if (last && !last.code && !p.code) last.text += p.text
    else acc.push({ ...p })
    return acc
  }, [])
}
