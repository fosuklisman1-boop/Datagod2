const round2 = (x: number) => Math.round(x * 100) / 100

export type BulkResult = { changes: { package_id: string; price: number }[]; skipped: string[] }

/**
 * price x (1 - percentOff/100), 2dp. Results <= 0 go to `skipped`.
 * Throws RangeError when percentOff is not a finite number in 0-100 (caller bug / bad request
 * the API should have rejected earlier).
 */
export function bulkFromPublic(pkgs: readonly { id: string; price: number }[], percentOff: number): BulkResult {
  if (!Number.isFinite(percentOff) || percentOff < 0 || percentOff > 100) {
    throw new RangeError("percentOff must be between 0 and 100")
  }
  const out: BulkResult = { changes: [], skipped: [] }
  for (const p of pkgs) {
    const price = round2(p.price * (1 - percentOff / 100))
    if (Number.isFinite(price) && price > 0) out.changes.push({ package_id: p.id, price })
    else out.skipped.push(p.id)
  }
  return out
}

/** source price + deltaGhs, 2dp. Results <= 0 go to `skipped`. Throws RangeError on non-finite delta. */
export function bulkFromRole(source: ReadonlyMap<string, number>, deltaGhs: number): BulkResult {
  if (!Number.isFinite(deltaGhs)) throw new RangeError("deltaGhs must be a finite number")
  const out: BulkResult = { changes: [], skipped: [] }
  for (const [id, base] of source) {
    const price = round2(base + deltaGhs)
    if (Number.isFinite(price) && price > 0) out.changes.push({ package_id: id, price })
    else out.skipped.push(id)
  }
  return out
}
