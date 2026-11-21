export type CopyChipType = "code" | "ussd" | "phone"
export type TextPart = { kind: "text"; value: string } | { kind: "chip"; value: string; chipType: CopyChipType }

// Reference codes the platform generates (see app/api/orders/purchase, lib/secure-random.ts, lib/afa-fulfillment.ts):
//   ORD-<13-digit ts>, ORD-<ts>-<9 safe chars>, AFA-<7 digits>, AT-/RCK-/RC-<3>-<3>, WD-<ts>-<9>, SBR-<hex>, BILL-<12 hex>.
const CODE = "(?:ORD|AFA|AT|RCK|RC|WD|SBR|BILL|TXN)-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*"
const USSD = "\\*\\d[\\d*]*#"
const PHONE = "(?:\\+233|233|0)\\d{9}"

// Whole tokens only: not preceded or followed by a word character, "-", "*" or "+" glued on.
const RE = new RegExp(`(?<![A-Za-z0-9_+*#-])(?:(${CODE})|(${USSD})|(${PHONE}))(?![A-Za-z0-9_*#-])`, "g")

/** Splits text into plain runs and copyable chips. Concatenating every value reproduces the input exactly. */
export function splitCopyChips(text: string): TextPart[] {
  const parts: TextPart[] = []
  let last = 0
  for (const m of text.matchAll(RE)) {
    const idx = m.index ?? 0
    if (idx > last) parts.push({ kind: "text", value: text.slice(last, idx) })
    parts.push({ kind: "chip", value: m[0], chipType: m[1] ? "code" : m[2] ? "ussd" : "phone" })
    last = idx + m[0].length
  }
  if (last < text.length) parts.push({ kind: "text", value: text.slice(last) })
  return parts
}
