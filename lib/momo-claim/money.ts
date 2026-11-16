/**
 * Fee = ceil(sent * percent / 100), computed in integer basis points so float
 * error (1000 * 1.1 / 100 = 11.000000000000002) can never round a fee up.
 */
export function computeFee(
  sentPesewas: number,
  feePercent: number,
): { feePesewas: number; netPesewas: number } {
  if (!Number.isFinite(feePercent) || feePercent < 0 || feePercent > 100) {
    throw new Error("Invalid fee percent")
  }
  const bp = Math.round(feePercent * 100)
  const feePesewas = Math.ceil((sentPesewas * bp) / 10000)
  return { feePesewas, netPesewas: sentPesewas - feePesewas }
}

/** Minimum applies to the NET (after fee) amount, maximum to the SENT amount. */
export function checkSessionAmount(
  sentPesewas: number,
  feePercent: number,
  minNetPesewas: number,
  maxSentPesewas: number,
): "ok" | "below_min" | "above_max" | "invalid" {
  if (!Number.isInteger(sentPesewas) || sentPesewas <= 0) return "invalid"
  if (sentPesewas > maxSentPesewas) return "above_max"
  const { netPesewas } = computeFee(sentPesewas, feePercent)
  if (netPesewas < minNetPesewas) return "below_min"
  return "ok"
}
