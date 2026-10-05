import type { OwnerCut } from "./types"

export type { OwnerCut }

export interface ClawbackLine {
  shopId: string
  ownerUserId: string | null
  credited: number
  pending: number
  fromProfit: number
  fromWallet: number
  shortfall: number
}

export interface ClawbackPlan {
  lines: ClawbackLine[]
  ok: boolean
}

const cents = (n: number) => Math.round(n * 100)
const money = (c: number) => c / 100

/**
 * Mirrors the arithmetic in the reserve_order_refund RPC (the RPC is authoritative;
 * this powers the preview). Per owner: strip the credited cut from the available
 * profit balance first, then the wallet. The pending (not yet credited) part is
 * simply cancelled and needs no balance. Negative balances count as zero capacity.
 */
export function planClawback(owners: OwnerCut[]): ClawbackPlan {
  const lines = [...owners]
    .sort((a, b) => (a.shopId < b.shopId ? -1 : a.shopId > b.shopId ? 1 : 0))
    .map((o) => {
      const credited = cents(o.credited)
      const available = Math.max(cents(o.availableBalance), 0)
      const wallet = Math.max(cents(o.walletBalance), 0)
      const fromProfit = Math.min(credited, available)
      const fromWallet = credited - fromProfit
      const shortfall = Math.max(fromWallet - wallet, 0)
      return {
        shopId: o.shopId,
        ownerUserId: o.ownerUserId,
        credited: money(credited),
        pending: o.pending,
        fromProfit: money(fromProfit),
        fromWallet: money(fromWallet),
        shortfall: money(shortfall),
      }
    })
  return { lines, ok: lines.every((l) => l.shortfall === 0) }
}
