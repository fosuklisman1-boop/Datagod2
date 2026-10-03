"use client"

import { useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useAuth } from "@/lib/auth-context"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { DashboardHeroBanner } from "@/components/shared/dashboard-hero-banner"
import { supabase } from "@/lib/supabase"
import { shopService } from "@/lib/shop-service"
import { shopOrigin } from "@/lib/shop-url"
import {
  Users, RefreshCw, Search, Copy, Share2, QrCode, X,
  Crown, ShoppingCart, TrendingUp, MessageSquare, Loader2, Tag,
} from "lucide-react"
import { toast } from "sonner"

interface Customer {
  id: string
  phone_number: string
  email: string
  customer_name: string
  first_purchase_at: string
  last_purchase_at: string
  total_purchases: number
  total_spent: number
  repeat_customer: boolean
}

const SORT_TABS = [
  { id: "recent", label: "Recent" },
  { id: "spend", label: "Top Spenders" },
  { id: "orders", label: "Most Orders" },
] as const
type SortTab = (typeof SORT_TABS)[number]["id"]

const GROWTH_TIPS = [
  "Post your link on WhatsApp status daily — consistency beats one big push.",
  "Print the QR code and place it where your community gathers.",
  "Reward returning customers with a small discount on bulk orders.",
  "Use SMS broadcasts to announce promos to your customer list.",
]

export default function CustomersPage() {
  const { user } = useAuth()
  const router = useRouter()
  const [shop, setShop] = useState<any>(null)
  const [customers, setCustomers] = useState<Customer[]>([])
  const [analytics, setAnalytics] = useState({ total_customers: 0, repeat_customers: 0, total_revenue: 0 })
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [search, setSearch] = useState("")
  const [sortTab, setSortTab] = useState<SortTab>("recent")
  const [showQr, setShowQr] = useState(false)

  useEffect(() => {
    if (user?.id) loadData()
  }, [user])

  const loadData = async () => {
    try {
      setLoading(true)
      const { data: { session } } = await supabase.auth.getSession()
      const token = session?.access_token
      if (!token) { toast.error("Your session expired. Please refresh and sign in again."); return }

      const { data: shopRow } = await supabase.from("user_shops").select("*").eq("user_id", user!.id).maybeSingle()
      const linkedCustomDomain = shopRow ? await shopService.getLinkedCustomDomain(shopRow.subdomain) : null
      setShop(shopRow ? { ...shopRow, linked_custom_domain: linkedCustomDomain } : shopRow)

      const [listRes, analyticsRes] = await Promise.all([
        fetch(`/api/admin/customers/list?limit=100&offset=0`, { headers: { Authorization: `Bearer ${token}` } }),
        fetch(`/api/admin/customers/analytics`, { headers: { Authorization: `Bearer ${token}` } }),
      ])

      if (listRes.ok) {
        const data = await listRes.json()
        setCustomers(data.customers || [])
      }
      if (analyticsRes.ok) {
        const data = await analyticsRes.json()
        setAnalytics({
          total_customers: data.total_customers || 0,
          repeat_customers: data.repeat_customers || 0,
          total_revenue: data.total_revenue || 0,
        })
      }
    } catch (error) {
      console.error("Error loading customers:", error)
      toast.error(error instanceof Error ? error.message : "Failed to load customers")
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }

  const handleRefresh = () => { setRefreshing(true); loadData() }

  const totalOrders = useMemo(() => customers.reduce((s, c) => s + (c.total_purchases || 0), 0), [customers])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    let list = customers.filter((c) =>
      !q || c.customer_name?.toLowerCase().includes(q) || c.phone_number?.includes(q) || c.email?.toLowerCase().includes(q)
    )
    list = [...list].sort((a, b) => {
      if (sortTab === "spend") return (b.total_spent || 0) - (a.total_spent || 0)
      if (sortTab === "orders") return (b.total_purchases || 0) - (a.total_purchases || 0)
      return new Date(b.last_purchase_at).getTime() - new Date(a.last_purchase_at).getTime()
    })
    return list
  }, [customers, search, sortTab])

  const shopLink = shop ? (shop.subdomain ? shopOrigin(shop.subdomain, shop.linked_custom_domain) : `${typeof window !== "undefined" ? window.location.origin : ""}/shop/${shop.shop_slug}`) : ""

  const copyLink = () => {
    navigator.clipboard.writeText(shopLink)
    toast.success("Shop link copied")
  }

  const shareOnWhatsApp = () => {
    const text = encodeURIComponent(`Check out my shop for cheap data bundles, airtime & results checker vouchers: ${shopLink}`)
    window.open(`https://wa.me/?text=${text}`, "_blank", "noopener,noreferrer")
  }

  if (loading) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center h-screen">
          <Loader2 className="w-8 h-8 animate-spin text-[#1b388b]" />
        </div>
      </DashboardLayout>
    )
  }

  return (
    <DashboardLayout>
      <div className="mx-auto max-w-2xl lg:max-w-4xl space-y-5">
        <DashboardHeroBanner backHref="/dashboard/my-shop" title="Customers" subtitle="Everyone who has bought from your shop — and the tools to find more." icon={Users}>
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            className="flex shrink-0 items-center gap-1.5 rounded-full border border-white/25 bg-white/10 px-3 py-1.5 text-sm font-semibold text-white hover:bg-white/20"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} /> Refresh
          </button>
        </DashboardHeroBanner>

        {/* Stats */}
        <div className="grid grid-cols-2 gap-2 sm:gap-3">
          <div className="rounded-2xl border border-border bg-card p-4">
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><Users className="h-3.5 w-3.5" /> Customers</p>
            <p className="mt-1 text-xl font-black text-foreground">{analytics.total_customers}</p>
          </div>
          <div className="rounded-2xl border border-border bg-card p-4">
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><Crown className="h-3.5 w-3.5" /> Returning</p>
            <p className="mt-1 text-xl font-black text-foreground">{analytics.repeat_customers}</p>
          </div>
          <div className="rounded-2xl border border-border bg-card p-4">
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><ShoppingCart className="h-3.5 w-3.5" /> Total Orders</p>
            <p className="mt-1 text-xl font-black text-foreground">{totalOrders}</p>
          </div>
          <div className="rounded-2xl border border-border bg-card p-4">
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><TrendingUp className="h-3.5 w-3.5" /> Total Revenue</p>
            <p className="mt-1 text-xl font-black text-foreground">GH₵{analytics.total_revenue.toFixed(2)}</p>
          </div>
        </div>

        {/* Grow Your Shop */}
        <div className="rounded-2xl bg-gradient-to-br from-[#1b388b] to-[#2a5ce8] p-5 text-white">
          <p className="flex items-center gap-1.5 text-sm font-bold"><Share2 className="h-4 w-4" /> Grow Your Shop</p>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
            <code className="flex-1 truncate rounded-xl bg-white/10 px-3 py-2 font-mono text-xs">{shopLink}</code>
            <div className="flex gap-2">
              <button onClick={copyLink} className="flex items-center gap-1.5 rounded-full bg-white px-3 py-2 text-xs font-bold text-[#1b388b] hover:bg-white/90">
                <Copy className="h-3.5 w-3.5" /> Copy
              </button>
              <button onClick={shareOnWhatsApp} className="flex items-center gap-1.5 rounded-full bg-success px-3 py-2 text-xs font-bold text-white hover:bg-success/90">
                <Share2 className="h-3.5 w-3.5" /> WhatsApp
              </button>
              <button onClick={() => setShowQr(true)} className="flex items-center gap-1.5 rounded-full bg-white/15 px-3 py-2 text-xs font-bold text-white hover:bg-white/25">
                <QrCode className="h-3.5 w-3.5" /> QR
              </button>
            </div>
          </div>
          <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-2">
            {GROWTH_TIPS.map((tip, i) => (
              <p key={i} className="flex items-start gap-1.5 text-xs text-white/80">
                <span className="mt-0.5">💡</span> {tip}
              </p>
            ))}
          </div>
        </div>

        {/* Search + sort */}
        <div className="space-y-2">
          <div className="relative">
            <Search className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search phone, name or email..."
              className="w-full rounded-2xl border border-border bg-card py-2.5 pl-10 pr-4 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-[#1b388b]/30"
            />
          </div>
          <div className="inline-flex w-full gap-1 rounded-2xl bg-muted p-1">
            {SORT_TABS.map(({ id, label }) => (
              <button
                key={id}
                onClick={() => setSortTab(id)}
                className={`flex-1 rounded-xl py-2 text-xs font-bold transition ${sortTab === id ? "bg-card text-foreground shadow-sm" : "text-muted-foreground"}`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* Customer list */}
        {filtered.length === 0 ? (
          <div className="rounded-2xl border border-border bg-card p-8 text-center">
            <Users className="mx-auto mb-2 h-10 w-10 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">{customers.length === 0 ? "No customers yet." : "No customers match your search."}</p>
          </div>
        ) : (
          <div className="rounded-2xl border border-border bg-card overflow-hidden">
            {filtered.map((c, i) => (
              <div key={c.id} className={`flex items-center justify-between gap-3 p-4 ${i !== 0 ? "border-t border-border" : ""}`}>
                <div className="flex items-center gap-3 min-w-0">
                  <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-sm font-bold ${c.repeat_customer ? "bg-amber-100 text-amber-600" : "bg-[#1b388b]/10 text-[#1b388b]"}`}>
                    {c.repeat_customer ? <Crown className="h-4 w-4" /> : (c.customer_name || c.phone_number || "?").charAt(0).toUpperCase()}
                  </span>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-foreground">{c.customer_name || c.phone_number}</p>
                    <p className="truncate text-xs text-muted-foreground">{c.phone_number}</p>
                  </div>
                </div>
                <div className="shrink-0 text-right">
                  <p className="text-sm font-semibold text-foreground">GH₵{Number(c.total_spent || 0).toFixed(2)}</p>
                  <p className="text-xs text-muted-foreground">{c.total_purchases} order{c.total_purchases === 1 ? "" : "s"}</p>
                  <p className="text-xs text-muted-foreground">{new Date(c.last_purchase_at).toLocaleDateString()}</p>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Message your customers */}
        <Link href="/dashboard/sms" className="flex items-center justify-between gap-3 rounded-2xl border border-success/30 bg-success/10 p-4 hover:bg-success/15">
          <div className="flex items-center gap-3 min-w-0">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-success/20 text-success"><MessageSquare className="h-4 w-4" /></span>
            <div>
              <p className="text-sm font-bold text-foreground">Message your customers</p>
              <p className="text-xs text-muted-foreground">Send promos and updates by SMS to your whole customer list.</p>
            </div>
          </div>
          <Tag className="h-4 w-4 shrink-0 text-success" />
        </Link>
      </div>

      {/* QR modal */}
      {showQr && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/60 p-4" onClick={() => setShowQr(false)}>
          <div className="rounded-2xl bg-card p-6 text-center shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between gap-4">
              <p className="text-sm font-bold text-foreground">Scan to visit your shop</p>
              <button onClick={() => setShowQr(false)} className="text-muted-foreground hover:text-foreground"><X className="h-4 w-4" /></button>
            </div>
            {shopLink && (
              <img
                src={`https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(shopLink)}`}
                alt="Shop link QR code"
                className="mt-4 rounded-xl border border-border"
                width={220}
                height={220}
              />
            )}
            <p className="mt-3 max-w-[220px] truncate text-xs text-muted-foreground">{shopLink}</p>
          </div>
        </div>
      )}
    </DashboardLayout>
  )
}
