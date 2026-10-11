"use client"
import type { ReactNode } from "react"
import { BadgeDollarSign, Coins, ShieldAlert, ShoppingCart, Tag, UserCheck } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import type { OverviewData } from "../_lib/api"
import { formatCount, formatGhs } from "../_lib/view"

function Stat({ icon, label, value, note }: { icon: ReactNode; label: string; value: string; note?: string }) {
  return (
    <Card className="clay border-0 py-0">
      <CardContent className="flex items-start gap-3 p-4">
        <div className="clay-icon flex size-10 shrink-0 items-center justify-center bg-primary/10 text-primary">{icon}</div>
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">{label}</p>
          <p className="break-words text-xl font-semibold tabular-nums">{value}</p>
          {note && <p className="mt-0.5 break-words text-xs leading-snug text-muted-foreground">{note}</p>}
        </div>
      </CardContent>
    </Card>
  )
}

export default function StatCards({ overview }: { overview: OverviewData }) {
  const s = overview.stats
  const u = overview.unrecorded
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 2xl:grid-cols-6">
      <Stat icon={<BadgeDollarSign className="size-5" />} label="Recorded revenue" value={formatGhs(s.recordedRevenueGhs)}
        note={u.purchases > 0 ? `${formatCount(u.purchases)} earlier purchases (${formatCount(u.credits)} credits) have no recorded amount` : undefined} />
      <Stat icon={<Coins className="size-5" />} label="Credits sold" value={formatCount(s.creditsSold)} />
      <Stat icon={<ShoppingCart className="size-5" />} label="Purchases" value={formatCount(s.purchases)} />
      <Stat icon={<UserCheck className="size-5" />} label="Pending reviews" value={formatCount(s.pendingReviews)} />
      <Stat icon={<Tag className="size-5" />} label="Pending senders" value={formatCount(s.pendingSenders)} />
      <Stat icon={<ShieldAlert className="size-5" />} label="Fraud flags" value={formatCount(s.fraudFlags)} />
    </div>
  )
}
