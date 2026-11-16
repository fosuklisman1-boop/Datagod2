"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { useAuth } from "@/lib/auth-context"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { DashboardHeroBanner } from "@/components/shared/dashboard-hero-banner"
import { supabase } from "@/lib/supabase"
import { MessageSquareText, Copy, Loader2, CheckCircle2, AlertTriangle, PauseCircle } from "lucide-react"
import { toast } from "sonner"

type Status = "off" | "closed" | "no_sms" | "paused" | "low" | "live"
type View = {
  hasShop: boolean
  status?: Status
  shopName?: string
  shopNumber?: string | null
  shopCode?: string | null
  balance?: number | null
  shareMessage?: string | null
  stats?: { orders: number; paid: number; delivered: number; creditsUsed: number }
  orders?: { id: string; size: string; recipient: string; gift: boolean; amount: number; status: string; createdAt: string }[]
}

const BANNER: Record<Status, { tone: "success" | "warning" | "muted"; title: string; body: string; cta?: string }> = {
  live: { tone: "success", title: "Text orders are live", body: "Customers can text your shop and buy data. Their orders are listed below, and you earn the same shop profit as on your USSD shop." },
  low: { tone: "warning", title: "Running low on SMS credits", body: "Each text order uses a few SMS credits for the replies to your customer. When you run out, text orders pause until you top up.", cta: "Top up SMS credits" },
  paused: { tone: "warning", title: "Paused: not enough SMS credits", body: "Customers who text your shop are told you cannot take text orders right now. Top up your SMS credits to start again.", cta: "Top up SMS credits" },
  no_sms: { tone: "warning", title: "Activate SMS to take text orders", body: "Replies to your customers are paid from your own SMS credits, so you need an active SMS account with some credits.", cta: "Set up SMS" },
  closed: { tone: "warning", title: "Your shop is not open for text orders", body: "Text orders need an approved, active shop with a shop code. Check your shop profile and the USSD/WhatsApp Bot page." },
  off: { tone: "muted", title: "Text orders are not open yet", body: "This feature is rolling out. When it opens for your shop you will see how your customers can order by text, right here." },
}

const fmt = (d: string) => new Date(d).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })

async function copy(text: string, ok: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast.success(ok)
  } catch {
    toast.error("Could not copy. Select the text and copy it by hand.")
  }
}

export default function TextOrdersPage() {
  const { user } = useAuth()
  const [view, setView] = useState<View | null>(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (!user?.id) return
    ;(async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession()
        const t = session?.access_token
        if (!t) { toast.error("Your session expired. Please refresh and sign in again."); setFailed(true); return }
        const res = await fetch("/api/user/text-orders", { headers: { Authorization: `Bearer ${t}` } })
        if (!res.ok) { setFailed(true); return }
        setView(await res.json())
      } catch {
        setFailed(true)
      } finally {
        setLoading(false)
      }
    })()
  }, [user])

  const banner = view?.status ? BANNER[view.status] : null
  const BannerIcon = banner?.tone === "success" ? CheckCircle2 : banner?.tone === "warning" ? (view?.status === "paused" ? PauseCircle : AlertTriangle) : MessageSquareText
  const toneClass = banner?.tone === "success" ? "border-success/40 bg-success/10" : banner?.tone === "warning" ? "border-warning/40 bg-warning/10" : "border-border bg-card"

  return (
    <DashboardLayout>
      <div className="mx-auto max-w-2xl lg:max-w-6xl space-y-5">
        <DashboardHeroBanner
          backHref="/dashboard/my-shop"
          title="Text Orders"
          subtitle="Let your customers buy from your shop by SMS."
          icon={MessageSquareText}
        />

        {loading ? (
          <div className="flex justify-center py-16"><Loader2 className="h-8 w-8 animate-spin text-primary" /></div>
        ) : failed ? (
          <div className="rounded-2xl border border-border bg-card p-6 text-sm text-muted-foreground">Could not load your text orders. Please refresh the page.</div>
        ) : !view?.hasShop ? (
          <div className="rounded-2xl border border-border bg-card p-6 text-sm text-muted-foreground">
            You need a shop to take text orders. <Link href="/dashboard/my-shop" className="font-bold text-primary underline">Set up your shop</Link>
          </div>
        ) : (
          <div className="grid gap-5 lg:grid-cols-2 lg:items-start">
            {banner && (
              <section className={`rounded-2xl border p-5 space-y-2 lg:col-span-2 ${toneClass}`}>
                <div className="flex items-start gap-3">
                  <BannerIcon className="mt-0.5 h-5 w-5 shrink-0" />
                  <div className="space-y-1">
                    <p className="font-bold">{banner.title}</p>
                    <p className="text-sm text-muted-foreground">{banner.body}</p>
                    {banner.cta && (
                      <Link href="/dashboard/sms" className="mt-1 inline-block rounded-full border border-primary px-3 py-1 text-xs font-bold text-primary">{banner.cta}</Link>
                    )}
                  </div>
                </div>
              </section>
            )}

            <section className="rounded-2xl border border-border bg-card p-5 space-y-3">
              <h2 className="font-bold">How your customers order</h2>
              {view.shareMessage && view.shopNumber && view.shopCode ? (
                <>
                  <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
                    <li>They send an SMS to <span className="font-bold text-foreground">{view.shopNumber}</span> with the size and your shop code, for example <span className="font-bold text-foreground">5GB {view.shopCode}</span>.</li>
                    <li>They get the price and a MoMo prompt on their phone, and approve it with their PIN.</li>
                    <li>Their data arrives within minutes. Next time they only text <span className="font-bold text-foreground">5GB</span>, because we remember your shop.</li>
                  </ol>
                  <p className="text-xs text-muted-foreground">Your shop code is <span className="font-bold text-foreground">{view.shopCode}</span>. Prices and profit are the same as on your USSD shop.</p>
                  <div className="rounded-xl bg-muted/50 p-3 text-sm">{view.shareMessage}</div>
                  <button
                    onClick={() => copy(view.shareMessage!, "Message copied. Paste it in your WhatsApp status or groups.")}
                    className="flex items-center gap-1.5 rounded-full border border-primary px-3 py-1 text-xs font-bold text-primary"
                  >
                    <Copy className="h-3 w-3" /> Copy message to share
                  </button>
                </>
              ) : (
                <p className="text-sm text-muted-foreground">Your shop number and code will show here as soon as text orders open for your shop.</p>
              )}
            </section>

            <section className="rounded-2xl border border-border bg-card p-5 space-y-3">
              <h2 className="font-bold">Last 30 days</h2>
              <div className="grid grid-cols-2 gap-3 text-center">
                {([
                  ["Text orders", view.stats?.orders ?? 0],
                  ["Paid", view.stats?.paid ?? 0],
                  ["Delivered", view.stats?.delivered ?? 0],
                  ["SMS credits used", view.stats?.creditsUsed ?? 0],
                ] as const).map(([label, n]) => (
                  <div key={label} className="rounded-xl bg-muted/50 p-3">
                    <p className="text-2xl font-bold">{n}</p>
                    <p className="text-xs text-muted-foreground">{label}</p>
                  </div>
                ))}
              </div>
              <div className="flex items-center justify-between rounded-xl border border-border p-3 text-sm">
                <span>SMS credits left: <span className="font-bold">{view.balance ?? "None yet"}</span></span>
                <Link href="/dashboard/sms" className="rounded-full border border-primary px-3 py-1 text-xs font-bold text-primary">Top up</Link>
              </div>
              <p className="text-xs text-muted-foreground">An order uses 2 SMS credits (3 when bought for another number) for the replies to your customer. Unused credits are returned when the order closes.</p>
            </section>

            <section className="rounded-2xl border border-border bg-card p-5 space-y-3 lg:col-span-2">
              <h2 className="font-bold">Recent text orders</h2>
              {(view.orders ?? []).length === 0 ? (
                <p className="text-sm text-muted-foreground">No text orders yet. Share your shop code and number so customers can start.</p>
              ) : (
                <ul className="divide-y divide-border">
                  {view.orders!.map((o) => (
                    <li key={o.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                      <div>
                        <p className="font-bold">{o.size} <span className="font-normal text-muted-foreground">for {o.recipient}{o.gift ? " (gift)" : ""}</span></p>
                        <p className="text-xs text-muted-foreground">{fmt(o.createdAt)}</p>
                      </div>
                      <div className="text-right">
                        <p className="font-bold">GHS {o.amount.toFixed(2)}</p>
                        <p className="text-xs text-muted-foreground">{o.status}</p>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              <p className="text-xs text-muted-foreground">Customers' own numbers are never shown here, only the number the data was sent to, partly hidden.</p>
            </section>
          </div>
        )}
      </div>
    </DashboardLayout>
  )
}
