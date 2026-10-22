import type { V2Context } from "../handler"

export function mapRole(ctx: V2Context) {
  return { role: ctx.role, key_type: ctx.keyType, environment: ctx.environment }
}

const round2 = (n: number) => parseFloat(Number(n).toFixed(2))

export interface BalanceDeps {
  wallets: { from(table: string): any }
  sandboxBalance(userId: string): Promise<number>
}

/** Test keys only ever read the sandbox; live keys only ever read wallets. */
export async function readBalance(
  ctx: V2Context,
  deps: BalanceDeps
): Promise<{ status: number; data?: unknown; error?: { status: 500; message: string } }> {
  if (ctx.environment === "test") {
    const balance = await deps.sandboxBalance(ctx.userId)
    return { status: 200, data: { balance, currency: "GHS", sandbox: true } }
  }
  const { data, error } = await deps.wallets
    .from("wallets")
    .select("balance, total_credited, total_spent")
    .eq("user_id", ctx.userId)
    .single()
  const mapped = error ? null : mapBalance(data)
  if (!mapped) {
    return { status: 500, error: { status: 500, message: "Failed to fetch wallet balance" } }
  }
  return { status: 200, data: mapped }
}

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
