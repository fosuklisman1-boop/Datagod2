// Statement reconciliation helpers for Send & Claim. Pure: no I/O, no logging (ids and CSV content are sensitive).

export class UnknownColumnError extends Error {
  constructor() {
    super("unknown_column")
    this.name = "UnknownColumnError"
  }
}

/** Minimal RFC 4180 parser: quoted fields, doubled quotes, commas and newlines inside quotes, CRLF or LF. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ""
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else inQuotes = false
      } else field += ch
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === ",") {
      row.push(field)
      field = ""
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++
      row.push(field)
      field = ""
      rows.push(row)
      row = []
    } else field += ch
  }
  if (field !== "" || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

const TXID_RE = /^\d{8,15}$/

/** Unique transaction ids (8-15 digits) from the named header column. Throws UnknownColumnError if the column is absent. */
export function extractStatementTxids(csv: string, column: string): string[] {
  const text = csv.charCodeAt(0) === 0xfeff ? csv.slice(1) : csv
  const rows = parseCsv(text)
  const want = column.trim().toLowerCase()
  const header = rows[0]
  const idx = header ? header.findIndex((h) => h.trim().toLowerCase() === want) : -1
  if (!want || idx < 0) throw new UnknownColumnError()
  const out = new Set<string>()
  for (let r = 1; r < rows.length; r++) {
    const v = (rows[r][idx] ?? "").trim()
    if (TXID_RE.test(v)) out.add(v)
  }
  return [...out]
}

/** Claimed ids inside [start 00:00 UTC, end 23:59:59.999 UTC] that the statement does not contain. Sorted, unique. */
export function findMissingClaims(
  claimed: { transactionId: string; claimedAt: string }[],
  statementTxids: Set<string>,
  period: { start: string; end: string },
): string[] {
  const from = Date.parse(`${period.start}T00:00:00.000Z`)
  const to = Date.parse(`${period.end}T23:59:59.999Z`)
  const missing = new Set<string>()
  for (const c of claimed) {
    const t = Date.parse(c.claimedAt)
    if (Number.isNaN(t) || t < from || t > to) continue
    if (!statementTxids.has(c.transactionId)) missing.add(c.transactionId)
  }
  return [...missing].sort()
}
