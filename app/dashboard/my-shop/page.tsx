"use client"

import { useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { useAuth } from "@/lib/auth-context"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { shopService, shopOrderService, shopProfitService } from "@/lib/shop-service"
import { shopOrigin } from "@/lib/shop-url"
import { supabase } from "@/lib/supabase"
import {
  Store, Copy, ExternalLink, RefreshCw, AlertCircle, Smartphone,
  ShoppingCart, Tag, Banknote, Users, Activity, Send, Settings as SettingsIcon,
  TrendingUp, CheckCircle2, Clock, Wallet, Megaphone, MessageSquare, Loader2, ArrowRight,
} from "lucide-react"
import { toast } from "sonner"

const DATE_RANGES = [
  { id: "all", label: "All" },
  { id: "today", label: "Today" },
  { id: "7d", label: "7D" },
  { id: "30d", label: "30D" },
] as const
type DateRange = (typeof DATE_RANGES)[number]["id"]

const QUICK_ACTIONS = [
  { href: "/dashboard/shop-orders", label: "Orders", icon: ShoppingCart },
  { href: "/dashboard/shop-pricing", label: "Pricing", icon: Tag },
  { href: "/dashboard/shop-withdraw", label: "Withdraw", icon: Banknote },
  { href: "/dashboard/customers", label: "Customers", icon: Users },
  { href: "/dashboard/shop-profit-logs", label: "Profit Logs", icon: Activity },
  { href: "/dashboard/sms", label: "SMS", icon: Send },
  { href: "/dashboard/ussd-shop", label: "USSD", icon: Smartphone },
  { href: "/dashboard/shop-profile", label: "Settings", icon: SettingsIcon },
] as const

function isWithinRange(dateStr: string, range: DateRange): boolean {
  if (range === "all") return true
  const d = new Date(dateStr).getTime()
  const now = Date.now()
  const days = range === "today" ? 1 : range === "7d" ? 7 : 30
  const start = range === "today"
    ? new Date(new Date().setHours(0, 0, 0, 0)).getTime()
    : now - days * 24 * 60 * 60 * 1000
  return d >= start
}

export default function ShopOverviewPage() {
  const { user } = useAuth()
  const [shop, setShop] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [dbError, setDbError] = useState<string | null>(null)
  const [formData, setFormData] = useState({ shop_name: "", description: "", logo_url: "" })
  const [userRole, setUserRole] = useState<string | null>(null)

  const [balance, setBalance] = useState<{ available_balance: number; credited_profit: number; withdrawn_profit: number } | null>(null)
  const [orders, setOrders] = useState<any[]>([])
  const [dateRange, setDateRange] = useState<DateRange>("all")

  const [ussdCode, setUssdCode] = useState<{ id: string; code: string; activation_fee_paid: boolean } | null>(null)
  const [ussdActivationFee, setUssdActivationFee] = useState(0)
  const [ussdDialCode, setUssdDialCode] = useState("")
  const [activatingUssd, setActivatingUssd] = useState(false)

  const [announcementMessage, setAnnouncementMessage] = useState("")
  const [savingNotice, setSavingNotice] = useState(false)
  const [smsToggleOn, setSmsToggleOn] = useState(true)
  const [savingSmsToggle, setSavingSmsToggle] = useState(false)
  const [hasActiveSender, setHasActiveSender] = useState(false)

  useEffect(() => {
    if (!user) return
    loadData()
  }, [user])

  const loadData = async () => {
    try {
      setLoading(true)
      setDbError(null)
      if (!user?.id) return

      const { data: { session } } = await supabase.auth.getSession()
      const token = session?.access_token

      try {
        const meRes = token ? await fetch("/api/user/me", { headers: { Authorization: `Bearer ${token}` } }) : null
        const me = meRes?.ok ? await meRes.json() : null
        setUserRole(me?.role ?? (user?.user_metadata?.role as string | undefined) ?? null)
      } catch {
        setUserRole((user?.user_metadata?.role as string | undefined) ?? null)
      }

      const userShop = await shopService.getShop(user.id)
      setShop(userShop)
      if (!userShop) return

      const [balanceData, orderList, settingsRes, ussdRow, cfgRes, senderRes] = await Promise.all([
        shopProfitService.getShopBalanceFromTable(userShop.id).catch(() => null),
        shopOrderService.getShopOrders(userShop.id).catch(() => []),
        fetch(`/api/shop/settings/${userShop.id}`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
        supabase.from("ussd_shop_codes").select("id, code, activation_fee_paid").eq("shop_id", userShop.id).maybeSingle(),
        fetch("/api/public/config").then((r) => (r.ok ? r.json() : { app_settings: {} })).catch(() => ({ app_settings: {} })),
        token ? supabase.from("sms_accounts").select("id").eq("user_id", user.id).maybeSingle() : Promise.resolve({ data: null }),
      ])

      setBalance(balanceData)
      setOrders(orderList || [])
      setAnnouncementMessage(settingsRes?.announcement_message || "")
      setSmsToggleOn(settingsRes?.order_confirmation_sms_enabled !== false)
      setUssdCode(ussdRow.data ?? null)
      const cfg = cfgRes?.app_settings ?? {}
      setUssdActivationFee(Number(cfg.ussd_shop_activation_fee ?? 0))
      setUssdDialCode(cfg.ussd_shop_dial_code ?? "")

      if (senderRes.data?.id) {
        const { data: activeSender } = await supabase
          .from("sms_sender_ids")
          .select("id")
          .eq("sms_account_id", senderRes.data.id)
          .eq("local_status", "active")
          .limit(1)
          .maybeSingle()
        setHasActiveSender(!!activeSender)
      } else {
        setHasActiveSender(false)
      }
    } catch (error) {
      console.error("Error loading shop overview:", error)
      toast.error(error instanceof Error ? error.message : "Failed to load shop overview")
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }

  const handleRefresh = () => { setRefreshing(true); loadData() }

  const filteredOrders = useMemo(
    () => orders.filter((o) => isWithinRange(o.created_at, dateRange)),
    [orders, dateRange]
  )

  const stats = useMemo(() => {
    const sales = filteredOrders.reduce((s, o) => s + (Number(o.total_price) || 0), 0)
    const profit = filteredOrders.reduce((s, o) => s + (Number(o.profit_amount) || 0), 0)
    const completed = filteredOrders.filter((o) => o.order_status === "completed").length
    const inProgress = filteredOrders.filter((o) => o.order_status !== "completed" && o.order_status !== "failed").length
    return { sales, profit, completed, inProgress }
  }, [filteredOrders])

  const recentOrders = useMemo(() => orders.slice(0, 3), [orders])

  const copyShopLink = () => {
    const link = shop.subdomain ? shopOrigin(shop.subdomain) : `${window.location.origin}/shop/${shop.shop_slug}`
    navigator.clipboard.writeText(link)
    toast.success("Shop link copied to clipboard")
  }

  const handleActivateUssd = async () => {
    setActivatingUssd(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) throw new Error("Your session expired. Please refresh and sign in again.")
      const res = await fetch("/api/dashboard/ussd-shop/activate", {
        method: "POST",
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || "Failed to activate USSD")
      toast.success("USSD ordering is now active for your shop!")
      loadData()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to activate USSD")
    } finally {
      setActivatingUssd(false)
    }
  }

  const handleSaveNotice = async () => {
    setSavingNotice(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) throw new Error("Your session expired. Please refresh and sign in again.")
      const message = announcementMessage.trim()
      const res = await fetch(`/api/shop/settings/${shop.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({
          announcement_message: message,
          // A per-shop announcement only ever renders on the storefront when
          // it has a non-empty title (app/api/shop/public-packages/route.ts) --
          // this UI has no title field, so default one whenever there's a
          // real message to show, and clear it when the notice is emptied.
          announcement_title: message ? (shop.shop_name || "Notice") : "",
          announcement_enabled: message.length > 0,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || "Failed to save notice")
      toast.success(message ? "Storefront notice saved" : "Storefront notice cleared")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to save notice")
    } finally {
      setSavingNotice(false)
    }
  }

  const handleToggleSms = async (next: boolean) => {
    setSmsToggleOn(next)
    setSavingSmsToggle(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) throw new Error("Your session expired. Please refresh and sign in again.")
      const res = await fetch(`/api/shop/settings/${shop.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ order_confirmation_sms_enabled: next }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || "Failed to save")
      toast.success(next ? "Order confirmation SMS turned on" : "Order confirmation SMS turned off")
    } catch (error) {
      setSmsToggleOn(!next)
      toast.error(error instanceof Error ? error.message : "Failed to save")
    } finally {
      setSavingSmsToggle(false)
    }
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

  if (!shop) {
    return (
      <DashboardLayout>
        <div className="mx-auto max-w-2xl lg:max-w-4xl space-y-5">
          <div>
            <h1 className="text-2xl font-bold text-foreground">My Shop</h1>
            <p className="mt-1 text-sm text-muted-foreground">Create your storefront to start selling.</p>
          </div>
          <div className="rounded-2xl border border-border bg-card p-4 sm:p-5 space-y-4">
            <div>
              <Label htmlFor="shop-name">Shop Name *</Label>
              <Input
                id="shop-name"
                value={formData.shop_name}
                onChange={(e) => setFormData({ ...formData, shop_name: e.target.value })}
                placeholder="e.g., My Mobile Shop"
                className="mt-1"
              />
            </div>
            <div>
              <Label htmlFor="shop-description">Description</Label>
              <Textarea
                id="shop-description"
                value={formData.description}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                placeholder="Tell customers about your shop..."
                className="mt-1"
                rows={4}
              />
            </div>
            <div>
              <Label htmlFor="shop-logo">Shop Logo</Label>
              <div className="mt-1 flex items-center gap-3">
                <Input
                  id="shop-logo"
                  type="file"
                  accept="image/*"
                  onChange={(e) => {
                    const file = e.target.files?.[0]
                    if (file) {
                      const reader = new FileReader()
                      reader.onloadend = () => setFormData({ ...formData, logo_url: reader.result as string })
                      reader.readAsDataURL(file)
                    }
                  }}
                />
                {formData.logo_url && (
                  <img src={formData.logo_url} alt="Logo preview" className="w-12 h-12 rounded-lg object-cover border border-border" />
                )}
              </div>
            </div>
            <Button
              onClick={async () => {
                if (!formData.shop_name.trim()) { toast.error("Shop name is required"); return }
                try {
                  if (!user?.id) { toast.error("User not authenticated"); return }
                  const baseSlug = formData.shop_name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
                  const randomSuffix = Math.random().toString(36).substring(2, 9)
                  const shopSlug = `${baseSlug}-${randomSuffix}`
                  const newShop = await shopService.createShop(user.id, {
                    shop_name: formData.shop_name, shop_slug: shopSlug,
                    description: formData.description, logo_url: formData.logo_url,
                  })
                  setShop(newShop)
                  toast.success("Shop created successfully!")
                } catch (error: any) {
                  toast.error(error?.message || "Failed to create shop")
                }
              }}
              disabled={loading}
              className="w-full rounded-2xl bg-[#1b388b] text-primary-foreground hover:bg-[#1b388b]/90 font-semibold"
            >
              Create Shop
            </Button>
          </div>
        </div>
      </DashboardLayout>
    )
  }

  const isDealer = userRole === "dealer" || userRole === "admin"
  const storefrontHref = shop.subdomain ? shopOrigin(shop.subdomain) : `/shop/${shop.shop_slug}`
  const ussdNeedsActivation = !ussdCode || !ussdCode.activation_fee_paid

  return (
    <DashboardLayout>
      <div className="mx-auto max-w-2xl lg:max-w-4xl space-y-5">
        {/* Shop header */}
        <div className="rounded-2xl border border-border bg-card p-4 sm:p-5">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-[#1b388b]/10 text-[#1b388b]">
                <Store className="h-6 w-6" />
              </span>
              <div className="min-w-0">
                <p className="truncate text-lg font-bold text-foreground">{shop.shop_name}</p>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  <Badge className={shop.is_active ? "bg-success/15 text-success" : "bg-warning/15 text-warning"}>
                    {shop.is_active ? "Active" : "Pending Approval"}
                  </Badge>
                  {isDealer && <Badge className="bg-[#1b388b]/10 text-[#1b388b]">Dealer</Badge>}
                </div>
              </div>
            </div>
            <Button variant="outline" size="sm" className="shrink-0 rounded-full" onClick={handleRefresh} disabled={refreshing}>
              <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${refreshing ? "animate-spin" : ""}`} /> Refresh
            </Button>
          </div>

          <div className="mt-4 flex items-center gap-2 rounded-2xl border border-border bg-muted/40 p-3">
            <code className="flex-1 truncate font-mono text-xs sm:text-sm text-foreground">
              {shop.subdomain ? shopOrigin(shop.subdomain) : `${typeof window !== "undefined" ? window.location.origin : ""}/shop/${shop.shop_slug}`}
            </code>
            <Button variant="outline" size="sm" className="shrink-0 rounded-full" onClick={copyShopLink}>
              <Copy className="h-3.5 w-3.5 mr-1.5" /> Copy
            </Button>
            <a href={storefrontHref} target="_blank" rel="noopener noreferrer">
              <Button size="sm" className="shrink-0 rounded-full bg-[#1b388b] text-primary-foreground hover:bg-[#1b388b]/90">
                <ExternalLink className="h-3.5 w-3.5" />
              </Button>
            </a>
          </div>
        </div>

        {/* USSD activation -- real per-shop activation_fee_paid flag + real
            admin-configured fee, self-service provisioning if no code exists yet. */}
        {ussdNeedsActivation && (
          <div className="flex items-center justify-between gap-3 rounded-2xl border border-[#1b388b]/20 bg-[#1b388b]/5 p-4">
            <div className="flex items-center gap-3 min-w-0">
              <Smartphone className="h-4 w-4 shrink-0 text-[#1b388b]" />
              <p className="text-sm text-foreground">
                Activate USSD — customers buy via {ussdDialCode ? <span className="font-mono font-semibold">{ussdDialCode}</span> : "USSD"}.
                {" "}One-time {ussdActivationFee > 0 ? `GHS ${ussdActivationFee.toFixed(2)}` : "free"}.
              </p>
            </div>
            <Button
              size="sm"
              className="shrink-0 rounded-full bg-[#1b388b] text-primary-foreground hover:bg-[#1b388b]/90"
              onClick={handleActivateUssd}
              disabled={activatingUssd}
            >
              {activatingUssd ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Set up"}
            </Button>
          </div>
        )}

        {/* Advisory — own sender ID for order-confirmation SMS. Never blocks
            sending (see app/api/fulfillment/process-order/route.ts). */}
        {!hasActiveSender && (
          <div className="flex items-start justify-between gap-3 rounded-2xl border border-warning/30 bg-warning/10 p-4">
            <div className="flex items-start gap-3 min-w-0">
              <AlertCircle className="h-4 w-4 mt-0.5 shrink-0 text-warning" />
              <div>
                <p className="text-sm font-bold text-foreground">Send order texts under your own name</p>
                <p className="text-xs text-muted-foreground">Request a sender ID so customer order confirmations show your shop's name instead of the default one.</p>
              </div>
            </div>
            <Link href="/dashboard/sms" className="shrink-0 flex items-center gap-1 text-xs font-semibold text-[#1b388b] hover:underline">
              Fix in SMS <ArrowRight className="h-3 w-3" />
            </Link>
          </div>
        )}

        {/* Quick actions */}
        <div className="grid grid-cols-4 gap-2 sm:gap-3">
          {QUICK_ACTIONS.map(({ href, label, icon: Icon }) => (
            <Link key={href} href={href} className="flex flex-col items-center gap-1.5 rounded-2xl border border-border bg-card p-3 text-center hover:border-[#1b388b]/30">
              <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-[#1b388b]/10 text-[#1b388b]">
                <Icon className="h-4 w-4" />
              </span>
              <span className="text-xs font-semibold text-foreground">{label}</span>
            </Link>
          ))}
          <a href={storefrontHref} target="_blank" rel="noopener noreferrer" className="flex flex-col items-center gap-1.5 rounded-2xl border border-border bg-card p-3 text-center hover:border-[#1b388b]/30">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-[#1b388b]/10 text-[#1b388b]">
              <ExternalLink className="h-4 w-4" />
            </span>
            <span className="text-xs font-semibold text-foreground">Storefront</span>
          </a>
        </div>

        {/* Performance */}
        <div>
          <div className="flex items-center justify-between">
            <p className="flex items-center gap-1.5 text-sm font-bold text-foreground"><TrendingUp className="h-4 w-4 text-[#1b388b]" /> Performance</p>
            <div className="inline-flex gap-1 rounded-2xl bg-muted p-1">
              {DATE_RANGES.map(({ id, label }) => (
                <button
                  key={id}
                  onClick={() => setDateRange(id)}
                  className={`rounded-xl px-3 py-1.5 text-xs font-bold transition ${dateRange === id ? "bg-card text-foreground shadow-sm" : "text-muted-foreground"}`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="mt-3 grid grid-cols-2 gap-2 sm:gap-3">
            <div className="rounded-2xl border border-border bg-card p-4">
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><Banknote className="h-3.5 w-3.5" /> Sales</p>
              <p className="mt-1 text-xl font-black text-foreground">GH₵{stats.sales.toFixed(2)}</p>
            </div>
            <div className="rounded-2xl border border-border bg-card p-4">
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><TrendingUp className="h-3.5 w-3.5" /> Profit</p>
              <p className="mt-1 text-xl font-black text-foreground">GH₵{stats.profit.toFixed(2)}</p>
            </div>
            <div className="rounded-2xl border border-border bg-card p-4">
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><CheckCircle2 className="h-3.5 w-3.5" /> Completed</p>
              <p className="mt-1 text-xl font-black text-foreground">{stats.completed}</p>
            </div>
            <div className="rounded-2xl border border-border bg-card p-4">
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><Clock className="h-3.5 w-3.5" /> In Progress</p>
              <p className="mt-1 text-xl font-black text-foreground">{stats.inProgress}</p>
            </div>
          </div>
        </div>

        {/* Available Profit */}
        <div className="rounded-2xl bg-gradient-to-br from-[#1b388b] to-[#2a5ce8] p-5 text-white">
          <p className="flex items-center gap-1.5 text-sm text-white/70"><Wallet className="h-4 w-4" /> Available Profit</p>
          <p className="mt-1 text-3xl font-black">GH₵{(balance?.available_balance || 0).toFixed(2)}</p>
          <p className="mt-1 text-xs text-white/70">
            Earned: GH₵{(balance?.credited_profit || 0).toFixed(2)} · Withdrawn: GH₵{(balance?.withdrawn_profit || 0).toFixed(2)}
          </p>
          <Link href="/dashboard/shop-withdraw">
            <button className="mt-4 flex w-full items-center justify-center gap-2 rounded-2xl bg-white py-3 text-sm font-bold text-[#1b388b] hover:bg-white/90">
              Withdraw Earnings <ArrowRight className="h-4 w-4" />
            </button>
          </Link>
        </div>

        {/* Storefront Notice */}
        <div className="rounded-2xl border border-border bg-card p-4 sm:p-5">
          <p className="flex items-center gap-1.5 text-sm font-bold text-foreground"><Megaphone className="h-4 w-4 text-[#1b388b]" /> Storefront Notice</p>
          <Textarea
            value={announcementMessage}
            onChange={(e) => setAnnouncementMessage(e.target.value)}
            placeholder="Enter your storefront notice here..."
            className="mt-3"
            rows={3}
            maxLength={2000}
          />
          <Button
            onClick={handleSaveNotice}
            disabled={savingNotice}
            className="mt-3 w-full rounded-2xl bg-[#1b388b] text-primary-foreground hover:bg-[#1b388b]/90"
          >
            {savingNotice ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
            Save Notice
          </Button>
        </div>

        {/* Customer order SMS toggle */}
        <div className="flex items-center justify-between gap-3 rounded-2xl border border-border bg-card p-4">
          <div className="flex items-start gap-3 min-w-0">
            <MessageSquare className="h-4 w-4 mt-0.5 shrink-0 text-[#1b388b]" />
            <div>
              <p className="text-sm font-bold text-foreground">Customer order SMS</p>
              <p className="text-xs text-muted-foreground">Text customers a confirmation each time they order from your shop.</p>
            </div>
          </div>
          <button
            role="switch"
            aria-checked={smsToggleOn}
            disabled={savingSmsToggle}
            onClick={() => handleToggleSms(!smsToggleOn)}
            className={`relative shrink-0 h-6 w-11 rounded-full transition disabled:opacity-50 ${smsToggleOn ? "bg-[#1b388b]" : "bg-muted"}`}
          >
            <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${smsToggleOn ? "translate-x-[22px]" : "translate-x-0.5"}`} />
          </button>
        </div>

        {/* Recent Activity */}
        <div className="rounded-2xl border border-border bg-card p-4 sm:p-5">
          <div className="flex items-center justify-between">
            <p className="text-sm font-bold text-foreground">Recent Activity</p>
            <Link href="/dashboard/shop-orders" className="flex items-center gap-1 text-xs font-semibold text-[#1b388b] hover:underline">
              View all <ArrowRight className="h-3 w-3" />
            </Link>
          </div>
          {recentOrders.length === 0 ? (
            <p className="mt-3 text-sm text-muted-foreground">No orders yet.</p>
          ) : (
            <div className="mt-3 divide-y divide-border">
              {recentOrders.map((order) => (
                <div key={order.id} className="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
                  <div className="flex items-center gap-3 min-w-0">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-success/10 text-sm font-bold text-success">
                      {(order.network || "?").charAt(0).toUpperCase()}
                    </span>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-foreground">{order.network} {order.volume_gb}GB</p>
                      <p className="truncate text-xs text-muted-foreground">{order.customer_phone}</p>
                    </div>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="text-sm font-semibold text-foreground">GH₵{Number(order.total_price || 0).toFixed(2)}</p>
                    <p className="text-xs text-success">+GH₵{Number(order.profit_amount || 0).toFixed(2)}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {!shop.is_active && (
          <div className="flex items-start gap-3 rounded-2xl border border-warning/30 bg-warning/10 p-4 text-sm text-foreground">
            <AlertCircle className="h-4 w-4 mt-0.5 shrink-0 text-warning" />
            <p>Your shop is pending admin approval. It'll go live on your storefront link once approved.</p>
          </div>
        )}
      </div>
    </DashboardLayout>
  )
}
