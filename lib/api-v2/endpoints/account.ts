import type { V2Context } from "../handler"

export function mapRole(ctx: V2Context) {
  return { role: ctx.role, key_type: ctx.keyType, environment: ctx.environment }
}

const round2 = (n: number) => parseFloat(Number(n).toFixed(2))

export function mapBalance(
  w: { balance: number; total_credited: number; total_spent: number } | null
) {
  if (!w) return null
  return {
    balance: round2(w.balance),
    total_credited: round2(w.total_credited),
    total_spent: round2(w.total_spent),
    currency: "GHS",
  }
}
