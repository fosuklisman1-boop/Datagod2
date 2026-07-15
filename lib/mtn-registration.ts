// Pure, DB-free helpers for the MTN registration admin feature.
// Consumes the jsonb payload of claim_mtn_registration_batch() and shapes
// xlsx rows for the provider file (single Phone column, local 0XXXXXXXXX).

export interface ClaimResult {
  batchId: string | null
  count: number
  phones: string[]
}

/** Defensive parse of the claim RPC's jsonb result. */
export function parseClaimResult(raw: unknown): ClaimResult {
  const o = (raw ?? {}) as Record<string, unknown>
  const phones = Array.isArray(o.phones) ? (o.phones as unknown[]).map(String) : []
  return {
    batchId: typeof o.batch_id === 'string' ? o.batch_id : null,
    count: Number(o.count) || 0,
    phones,
  }
}

export interface MtnSheetRow {
  Phone: string
}

/** One row per phone; single `Phone` column in local 0XXXXXXXXX format. */
export function buildMtnRegistrationRows(phones: string[]): MtnSheetRow[] {
  return phones.map(phone => ({ Phone: phone }))
}
