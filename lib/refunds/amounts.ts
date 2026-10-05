const cents = (n: number) => Math.round(n * 100)

export function defaultRefundAmount(paid: number, fee: number): number {
  return Math.max(cents(paid) - cents(fee), 0) / 100
}

export function validateRefundAmount(amount: number, paid: number): string | null {
  if (!Number.isFinite(amount) || amount <= 0) return "Refund amount must be greater than zero"
  if (Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-6) return "Refund amount can have at most 2 decimal places"
  if (cents(amount) > cents(paid)) return "Refund amount cannot exceed what the customer paid"
  return null
}
