// Pure screen helpers for the cashback-priced Uzo USSD menus (main + shop).
// Wording rule: no "data" / "bundle" words on any Uzo screen.

export const UZO_SCREEN_LIMIT = 160

const DEFAULT_PAGE_SIZE = 5
const MIN_LABEL = 3

export function uzoSafeLabel(text: string): string {
  const out = (text ?? "")
    .replace(/bundles?/gi, "")
    .replace(/(?<![A-Za-z])data(?![A-Za-z])/gi, "Internet")
    .replace(/\s+/g, " ")
    .trim()
  return out || "Plan"
}

export function fitsUzo(text: string): boolean {
  return text.length <= UZO_SCREEN_LIMIT
}

function cut(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, Math.max(0, max))
}

export function uzoPagedList<T>(
  items: T[],
  page: number,
  label: (t: T) => string,
  opts: { header: string; pageSize?: number }
): { text: string; pageItems: T[]; hasMore: boolean } {
  const pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE
  const offset = Math.max(0, page) * pageSize
  const pageItems = items.slice(offset, offset + pageSize)
  const hasMore = offset + pageItems.length < items.length
  const labels = pageItems.map((t) => label(t))

  const build = (max: number): string => {
    const lines = labels.map((l, i) => `${offset + i + 1}. ${cut(l, max)}`)
    if (hasMore) lines.push(`${offset + pageItems.length + 1}. More...`)
    lines.push("0. Back")
    return `${opts.header}\n${lines.join("\n")}`
  }

  const longest = labels.reduce((m, l) => Math.max(m, l.length), MIN_LABEL)
  let text = build(longest)
  for (let max = longest - 1; !fitsUzo(text) && max >= MIN_LABEL; max--) {
    text = build(max)
  }
  return { text, pageItems, hasMore }
}

export function uzoConfirmText(o: {
  pay: number
  face: number
  receive: string
  recipient?: string
  payer: string
}): string {
  const was = o.pay < o.face ? ` (was GHS ${o.face.toFixed(2)})` : ""
  const build = (receive: string) =>
    `Pay GHS ${o.pay.toFixed(2)}${was}\n` +
    `You get ${receive}\n` +
    (o.recipient ? `To: ${o.recipient}\n` : "") +
    `MoMo: ${o.payer}\n` +
    `1. Confirm\n2. Cancel`

  let text = build(o.receive)
  if (!fitsUzo(text)) {
    const over = text.length - UZO_SCREEN_LIMIT
    text = build(cut(o.receive, Math.max(MIN_LABEL, o.receive.length - over)))
  }
  return text
}

export function botErrorText(status: number): string {
  switch (status) {
    case 409:
      return "Price changed. Please try again."
    case 429:
      return "Too many attempts. Please try later."
    case 403:
      return "Not available right now."
    default:
      return "Service unavailable. Please try again later."
  }
}
