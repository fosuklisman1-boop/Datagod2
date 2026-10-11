"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { BarChart3, BellRing, ChevronRight, CreditCard, History, Send, Users, Wallet, Building2 } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Switch } from "@/components/ui/switch"
import { smsFetch } from "./_lib/api"
import { useSmsAccount } from "./_lib/useSmsAccount"
import { limitsLine } from "./_lib/view"
import { SmsShell } from "./_components/SmsShell"
import { ActivationCard } from "./_components/ActivationCard"

/** Shown when the account has no active sender ID of its own. */
const PLATFORM_SENDER_NAME = "Datagod"

interface SenderRow { sender_id: string; local_status: string }

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  if (!Number.isFinite(diff)) return ""
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return "just now"
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days < 30) return `${days}d ago`
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" })
}

const TILES = [
  { href: "/dashboard/sms/records", label: "Records", desc: "Past campaigns and delivery", icon: History },
  { href: "/dashboard/sms/contacts", label: "Contacts", desc: "Groups and numbers", icon: Users },
  { href: "/dashboard/sms/credits", label: "Credits", desc: "Buy and review credits", icon: CreditCard },
  { href: "/dashboard/sms/business", label: "Business & Sender ID", desc: "Sender names and verification", icon: Building2 },
]

export default function SmsHomePage() {
  const { account, limits, stats, recentLedger, walletBalance, profitBalance } = useSmsAccount()
  const [senders, setSenders] = useState<SenderRow[] | null>(null)

  useEffect(() => {
    let alive = true
    void smsFetch<SenderRow[]>("/api/sms/sender-ids").then((r) => {
      if (alive) setSenders(r.ok && Array.isArray(r.data) ? r.data : [])
    })
    return () => { alive = false }
  }, [])

  const isPlatform = account?.ownerType === "platform"
  const isActive = account?.status === "active"
  const isSuspended = account?.status === "suspended"
  const showActivation = !!account && !isPlatform && !isActive && !isSuspended

  const activeSender = senders?.find((s) => s.local_status === "active")?.sender_id
  const sendingAs = activeSender ?? PLATFORM_SENDER_NAME
  const canSend = isActive || isPlatform

  return (
    <SmsShell subtitle="Send bulk SMS to your customers with your own sender ID.">
      {showActivation ? (
        <ActivationCard />
      ) : (
        <>
          <ActivationCard />

          <div className="grid gap-4 lg:grid-cols-3">
            <div className="clay space-y-4 bg-primary p-5 text-primary-foreground lg:col-span-2">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm text-primary-foreground/80">SMS credits</p>
                  <p className="text-4xl font-black">{(account?.unitBalance ?? 0).toLocaleString("en-US")}</p>
                  {(account?.pendingUnits ?? 0) > 0 && (
                    <p className="mt-1 text-xs text-primary-foreground/80">
                      + {account!.pendingUnits.toLocaleString("en-US")} pending
                    </p>
                  )}
                </div>
                <Badge variant="outline" className="border-primary-foreground/40 text-primary-foreground">
                  Sending as {sendingAs}
                </Badge>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button asChild disabled={!canSend} className="bg-background text-primary hover:bg-background/90">
                  <Link href="/dashboard/sms/compose"><Send className="h-4 w-4" /> Send SMS</Link>
                </Button>
                <Button asChild variant="outline" className="border-primary-foreground/40 bg-transparent text-primary-foreground hover:bg-primary-foreground/10">
                  <Link href="/dashboard/sms/credits"><CreditCard className="h-4 w-4" /> Buy Credits</Link>
                </Button>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3 lg:grid-cols-1">
              <Card className="clay border-success/30 bg-success/5">
                <CardHeader className="pb-2">
                  <CardDescription className="flex items-center gap-1.5"><Wallet className="h-4 w-4" /> Profit Wallet</CardDescription>
                  <CardTitle className="text-xl">GH₵{profitBalance.toFixed(2)}</CardTitle>
                </CardHeader>
                <CardContent><p className="text-xs text-muted-foreground">available</p></CardContent>
              </Card>
              <Card className="clay border-primary/30 bg-primary/5">
                <CardHeader className="pb-2">
                  <CardDescription className="flex items-center gap-1.5"><Wallet className="h-4 w-4" /> Main Wallet</CardDescription>
                  <CardTitle className="text-xl">GH₵{walletBalance.toFixed(2)}</CardTitle>
                </CardHeader>
                <CardContent><p className="text-xs text-muted-foreground">available</p></CardContent>
              </Card>
            </div>
          </div>

          <Card className="clay">
            <CardContent className="flex items-center justify-between gap-3 pt-6">
              <div className="flex items-start gap-3">
                <BellRing className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
                <div>
                  <p className="text-sm font-semibold text-foreground">Order confirmation SMS</p>
                  <p className="text-xs text-muted-foreground">Coming soon — automatically text customers when they order.</p>
                </div>
              </div>
              <Switch disabled checked={false} aria-label="Order confirmation SMS (coming soon)" />
            </CardContent>
          </Card>

          <div className="space-y-2">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <BarChart3 className="h-4 w-4 text-primary" /> Last 30 days
            </h2>
            <div className="grid grid-cols-3 gap-3">
              {[
                { label: "Campaigns", value: stats?.campaigns ?? 0 },
                { label: "Recipients", value: stats?.recipients ?? 0 },
                { label: "Credits used", value: stats?.creditsUsed ?? 0 },
              ].map((s) => (
                <Card key={s.label} className="clay">
                  <CardContent className="p-4">
                    <p className="text-xl font-bold text-foreground">{s.value.toLocaleString("en-US")}</p>
                    <p className="text-xs text-muted-foreground">{s.label}</p>
                  </CardContent>
                </Card>
              ))}
            </div>
            {limits && <p className="text-xs text-muted-foreground">Limits: {limitsLine(limits)}</p>}
          </div>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {TILES.map((t) => (
              <Link key={t.href} href={t.href} className="clay flex items-center gap-3 p-4 transition-transform hover:-translate-y-0.5">
                <div className="clay-icon grid h-10 w-10 shrink-0 place-items-center bg-primary/10">
                  <t.icon className="h-5 w-5 text-primary" />
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-foreground">{t.label}</p>
                  <p className="truncate text-xs text-muted-foreground">{t.desc}</p>
                </div>
              </Link>
            ))}
          </div>

          <Card className="clay">
            <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-base">Recent Credit Activity</CardTitle>
              <Link href="/dashboard/sms/credits" className="inline-flex items-center gap-0.5 text-sm font-medium text-primary hover:underline">
                View all <ChevronRight className="h-4 w-4" />
              </Link>
            </CardHeader>
            <CardContent>
              {recentLedger.length === 0 ? (
                <p className="py-4 text-center text-sm text-muted-foreground">No credit activity yet.</p>
              ) : (
                <ul className="divide-y divide-border">
                  {recentLedger.slice(0, 5).map((e) => (
                    <li key={e.id} className="flex items-center justify-between gap-3 py-2.5">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-foreground">{e.label}</p>
                        <p className="text-xs text-muted-foreground">{timeAgo(e.created_at)}</p>
                      </div>
                      <span className={`shrink-0 text-sm font-bold ${e.delta >= 0 ? "text-success" : "text-foreground"}`}>
                        {e.delta >= 0 ? "+" : "-"}{Math.abs(e.delta).toLocaleString("en-US")}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </SmsShell>
  )
}
