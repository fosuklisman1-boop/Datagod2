import { balanceLine } from "@/lib/cashback/display"

/** "You pay" (bold, right) / "You receive" / balance line with the red shortfall. */
export function PriceSummary({ pay, receive, balance }: { pay: number; receive: string; balance: number | null }) {
  const bal = balance !== null ? balanceLine(balance, pay) : null
  return (
    <div className="space-y-1.5 text-sm">
      <div className="flex items-baseline justify-between gap-4">
        <span className="text-muted-foreground">You pay</span>
        <span className="text-lg font-extrabold text-foreground">GHS {pay.toFixed(2)}</span>
      </div>
      <div className="flex items-baseline justify-between gap-4">
        <span className="text-muted-foreground">You receive</span>
        <span className="text-right font-semibold text-foreground">{receive}</span>
      </div>
      {bal && (
        <p className="text-xs text-muted-foreground">
          {bal.text}
          {bal.short && <span className="font-bold text-destructive"> — {bal.short}</span>}
        </p>
      )}
    </div>
  )
}
