/** Raw aggregate rows returned by the admin dashboard DB queries. Numerics may be null
 *  when there are no qualifying rows (Postgres SUM/COUNT on empty set returns null). */
export interface RawRevenueSums {
  /** COUNT of sms_accounts where amount_paid > 0 (paid activations). */
  activationCount: number | null
  /** SUM(amount_paid) across all activated sms_accounts. */
  activationTotal: number | null
  /** SUM(delta) for sms_unit_transactions with reason IN ('bundle_wallet','bundle_paystack').
   *  This is the total credits (units) sold via bundle purchases. */
  bundleUnitsSold: number | null
  /** Total GHS collected for bundle purchases. Currently 0 — sms_unit_transactions does not
   *  store per-purchase GHS price. Filled in when M5 adds a price column. */
  bundleGhsTotal: number | null
}

export interface RevenueSummary {
  /** Count of paid activations. */
  activations: number
  /** Total GHS collected as activation fees. */
  activationTotal: number
  /** Total GHS collected as bundle purchases. */
  bundleTotal: number
  /** Total SMS credits (units) sold via bundle purchases. */
  creditsSold: number
}

/** Shape raw DB aggregate rows into a typed revenue summary. Pure — no side effects.
 *  All null/undefined inputs normalise to 0 so the UI never renders NaN. */
export function aggregateRevenue(raw: RawRevenueSums): RevenueSummary {
  return {
    activations:     raw.activationCount  != null ? Number(raw.activationCount)  : 0,
    activationTotal: raw.activationTotal  != null ? Number(raw.activationTotal)  : 0,
    bundleTotal:     raw.bundleGhsTotal   != null ? Number(raw.bundleGhsTotal)   : 0,
    creditsSold:     raw.bundleUnitsSold  != null ? Number(raw.bundleUnitsSold)  : 0,
  }
}
