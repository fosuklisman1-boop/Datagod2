"use client"

import { useEffect, useState } from "react"
import { useAuth } from "@/lib/auth-context"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { DashboardHeroBanner } from "@/components/shared/dashboard-hero-banner"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { supabase } from "@/lib/supabase"
import { Smartphone, Hash, Coins, Copy, CheckCircle, RefreshCw, AlertCircle, Wallet, Loader2, MessageCircle, Tag } from "lucide-react"
import { toast } from "sonner"
import { validateUssdDisplayName } from "@/lib/ussd-display-name"

interface UssdShopCode {
  id: string
  code: string
  status: 'inactive' | 'active' | 'suspended'
  token_balance: number
  activation_fee_paid: boolean
  created_at: string
  whatsapp_activated: boolean
  whatsapp_activated_at: string | null
}

interface ShopOrder {
  id: string
  dialing_phone: string
  recipient_phone: string
  network: string
  package_size: string
  amount: number
  order_status: string
  payment_status: string
  created_at: string
}

export default function UssdShopPage() {
  const { user } = useAuth()
  const [shopCode, setShopCode] = useState<UssdShopCode | null>(null)
  const [dialCode, setDialCode] = useState("")
  const [orders, setOrders] = useState<ShopOrder[]>([])
  const [loading, setLoading] = useState(true)
  const [copied, setCopied] = useState(false)
  const [activationFee, setActivationFee] = useState(0)
  const [sessionPrice, setSessionPrice] = useState(0)
  const [minSessions, setMinSessions] = useState(1)
  const [maxSessions, setMaxSessions] = useState(100)
  const [walletBalance, setWalletBalance] = useState<number | null>(null)
  const [activating, setActivating] = useState(false)
  const [sessionQty, setSessionQty] = useState("")
  const [buyingSessions, setBuyingSessions] = useState(false)
  const [whatsappFee, setWhatsappFee] = useState(0)
  const [whatsappActivating, setWhatsappActivating] = useState(false)
  const [waLinkCopied, setWaLinkCopied] = useState(false)
  const [shopName, setShopName] = useState("")
  const [displayNameInput, setDisplayNameInput] = useState("")
  const [savingDisplayName, setSavingDisplayName] = useState(false)
  const [displayNameError, setDisplayNameError] = useState<string | null>(null)

  useEffect(() => {
    if (!user) return
    loadData()
  }, [user])

  const loadData = async () => {
    setLoading(true)
    try {
      const { data: shopRow } = await supabase
        .from("user_shops")
        .select("id, shop_name, ussd_display_name")
        .eq("user_id", user!.id)
        .single()

      if (!shopRow) { setLoading(false); return }

      setShopName(shopRow.shop_name ?? "")
      setDisplayNameInput(shopRow.ussd_display_name ?? "")

      // app_settings is service-role only; read ussd config via curated public API.
      const [codeRes, cfgRes, ordersRes, walletRes] = await Promise.all([
        supabase
          .from("ussd_shop_codes")
          .select("id, code, status, token_balance, activation_fee_paid, created_at, whatsapp_activated, whatsapp_activated_at")
          .eq("shop_id", shopRow.id)
          .maybeSingle(),
        fetch("/api/public/config").then(r => r.ok ? r.json() : { app_settings: {} }).catch(() => ({ app_settings: {} })),
        supabase
          .from("ussd_shop_orders")
          .select("id, dialing_phone, recipient_phone, network, package_size, amount, order_status, payment_status, created_at")
          .eq("shop_id", shopRow.id)
          .order("created_at", { ascending: false })
          .limit(20),
        supabase
          .from("wallets")
          .select("balance")
          .eq("user_id", user!.id)
          .maybeSingle(),
      ])

      const ussdCfg = cfgRes?.app_settings ?? {}
      setShopCode(codeRes.data ?? null)
      setDialCode(ussdCfg.ussd_shop_dial_code ?? "")
      setActivationFee(Number(ussdCfg.ussd_shop_activation_fee ?? 0))
      setSessionPrice(Number(ussdCfg.ussd_shop_session_price ?? 0))
      setMinSessions(Number(ussdCfg.ussd_shop_min_sessions ?? 1))
      setMaxSessions(Number(ussdCfg.ussd_shop_max_sessions ?? 100))
      setWhatsappFee(Number(ussdCfg.whatsapp_shop_activation_fee ?? 0))
      setOrders(ordersRes.data ?? [])
      setWalletBalance(walletRes.data ? Number(walletRes.data.balance) : null)
    } catch {
      toast.error("Failed to load USSD data")
    } finally {
      setLoading(false)
    }
  }

  const handleActivate = async () => {
    setActivating(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const res = await fetch("/api/dashboard/ussd-shop/activate", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token}` },
        body: JSON.stringify({}),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? "Activation failed")
      toast.success("Shop code activated!")
      await loadData()
    } catch (err: any) {
      toast.error(err.message ?? "Activation failed")
    } finally {
      setActivating(false)
    }
  }

  const handleActivateWhatsapp = async () => {
    setWhatsappActivating(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const res = await fetch("/api/dashboard/ussd-shop/whatsapp-activate", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token}` },
        body: JSON.stringify({}),
      })
      const json = await res.json()
      if (res.status === 409) {
        // The atomic-claim endpoint lost the race to another request (e.g. a
        // double-click) — the shop IS already WhatsApp-activated, it's not a real
        // failure. Refresh so the card flips to the activated view instead of
        // leaving the fee/button stuck showing alongside a scary red error.
        toast.info("This shop is already WhatsApp-activated")
        await loadData()
        return
      }
      if (!res.ok) throw new Error(json.error ?? "Activation failed")
      toast.success("WhatsApp shop activated!")
      await loadData()
    } catch (err: any) {
      toast.error(err.message ?? "Activation failed")
    } finally {
      setWhatsappActivating(false)
    }
  }

  const handleBuySessions = async () => {
    const qty = parseInt(sessionQty)
    if (!qty || qty < minSessions || qty > maxSessions) {
      toast.error(`Enter a quantity between ${minSessions} and ${maxSessions}`)
      return
    }
    setBuyingSessions(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const res = await fetch("/api/dashboard/ussd-shop/buy-sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token}` },
        body: JSON.stringify({ sessions: qty }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? "Purchase failed")
      toast.success(`${qty} sessions added!`)
      setSessionQty("")
      await loadData()
    } catch (err: any) {
      toast.error(err.message ?? "Purchase failed")
    } finally {
      setBuyingSessions(false)
    }
  }

  const handleSaveDisplayName = async () => {
    // An empty/whitespace-only input means "clear the override" (see the
    // matching special-case in the API route) — only non-empty input goes
    // through the blocked-word/length validation.
    if (displayNameInput.trim()) {
      const validation = validateUssdDisplayName(displayNameInput)
      if (!validation.valid) {
        setDisplayNameError(validation.reason)
        return
      }
    }
    setDisplayNameError(null)
    setSavingDisplayName(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const res = await fetch("/api/dashboard/ussd-shop/display-name", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token}` },
        body: JSON.stringify({ name: displayNameInput }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? "Save failed")
      setDisplayNameInput(json.ussd_display_name ?? "")
      toast.success(json.ussd_display_name ? "Display name saved!" : "Reverted to your shop name.")
    } catch (err: any) {
      setDisplayNameError(err.message ?? "Save failed")
    } finally {
      setSavingDisplayName(false)
    }
  }

  const copyCode = () => {
    if (!shopCode) return
    navigator.clipboard.writeText(shopCode.code)
    setCopied(true)
    toast.success("Shop code copied!")
    setTimeout(() => setCopied(false), 2000)
  }

  const whatsappShopNumber = process.env.NEXT_PUBLIC_WHATSAPP_SHOP_NUMBER
  const waLink = whatsappShopNumber && shopCode
    ? `https://wa.me/${whatsappShopNumber}?text=${encodeURIComponent(shopCode.code)}`
    : null

  const copyWaLink = () => {
    if (!waLink) return
    navigator.clipboard.writeText(waLink)
    setWaLinkCopied(true)
    toast.success("WhatsApp shop link copied!")
    setTimeout(() => setWaLinkCopied(false), 2000)
  }

  const statusBadge = (status: string, tokenBalance: number) => {
    if (status === 'suspended') return <Badge className="bg-amber-500/10 text-amber-600 border-border">Suspended</Badge>
    if (status === 'active' && tokenBalance === 0) return <Badge className="bg-amber-500/10 text-amber-600 border-border">No Sessions</Badge>
    if (status === 'active') return <Badge className="bg-success/15 text-success border-border">Active</Badge>
    return <Badge className="bg-muted text-muted-foreground border-border">Inactive</Badge>
  }

  const orderStatusBadge = (status: string) => {
    if (status === 'completed') return <Badge className="bg-success/15 text-success text-xs">Completed</Badge>
    if (status === 'failed') return <Badge className="bg-destructive/15 text-destructive text-xs">Failed</Badge>
    if (status === 'processing') return <Badge className="bg-[#1b388b]/10 text-[#1b388b] text-xs">Processing</Badge>
    if (status === 'held_registration') return <Badge className="bg-amber-500/10 text-amber-600 text-xs">Activating number</Badge>
    return <Badge className="bg-muted text-muted-foreground text-xs">Pending</Badge>
  }

  if (loading) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center h-screen">
          <RefreshCw className="w-8 h-8 animate-spin text-[#1b388b]" />
        </div>
      </DashboardLayout>
    )
  }

  return (
    <DashboardLayout>
      <div className="mx-auto max-w-2xl lg:max-w-3xl space-y-5">

        <DashboardHeroBanner title="USSD & WhatsApp Storefront" subtitle="Let your customers buy data bundles by USSD or WhatsApp" icon={Smartphone}>
          <button
            onClick={loadData}
            className="flex shrink-0 items-center gap-1.5 rounded-full border border-white/25 bg-white/10 px-3 py-1.5 text-sm font-semibold text-white hover:bg-white/20"
          >
            <RefreshCw className="h-3.5 w-3.5" /> Refresh
          </button>
        </DashboardHeroBanner>

        {!shopCode ? (
          <div className="rounded-2xl border-2 border-dashed border-border bg-card p-12 text-center">
            <Hash className="mx-auto mb-3 h-10 w-10 text-muted-foreground opacity-40" />
            <p className="font-medium text-foreground">No USSD code assigned yet</p>
            <p className="mt-1 text-sm text-muted-foreground">Contact admin to get your shop's USSD code set up.</p>
          </div>
        ) : (
          <Tabs defaultValue="ussd">
            <TabsList className="mb-2">
              <TabsTrigger value="ussd">USSD</TabsTrigger>
              <TabsTrigger value="whatsapp">WhatsApp Bot</TabsTrigger>
            </TabsList>

            <TabsContent value="ussd" className="space-y-5">
              {/* Shop Code hero */}
              <div className="rounded-2xl bg-gradient-to-br from-[#1b388b] to-[#2a5ce8] p-5 text-white">
                <div className="flex items-center justify-between">
                  <p className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-white/80">
                    <Hash className="h-3.5 w-3.5" /> Your Shop Code
                  </p>
                  {statusBadge(shopCode.status, shopCode.token_balance)}
                </div>
                <div className="mt-3 flex items-center gap-3">
                  <div className="flex-1 rounded-xl border border-white/20 bg-white/10 px-6 py-4 text-center">
                    <span className="font-mono text-4xl font-black tracking-widest">{shopCode.code}</span>
                    <p className="mt-1 text-xs text-white/70">Enter this code on the USSD prompt</p>
                  </div>
                  <button
                    onClick={copyCode}
                    className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-white/20 bg-white/10 hover:bg-white/20"
                  >
                    {copied ? <CheckCircle className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                  </button>
                </div>

                <div className="mt-4 flex items-center gap-2 border-t border-white/20 pt-3 text-sm text-white/90">
                  <Coins className="h-4 w-4" />
                  <span>
                    <strong>{shopCode.token_balance}</strong> session{shopCode.token_balance !== 1 ? 's' : ''} remaining
                  </span>
                  {shopCode.token_balance <= 5 && shopCode.token_balance > 0 && (
                    <span className="rounded-full bg-white/20 px-2 py-0.5 text-[10px] font-bold">Low</span>
                  )}
                  {shopCode.token_balance === 0 && (
                    <span className="rounded-full bg-white/20 px-2 py-0.5 text-[10px] font-bold">Depleted</span>
                  )}
                </div>
              </div>

              {shopCode.token_balance === 0 && shopCode.activation_fee_paid && (
                <div className="flex items-start gap-2 rounded-2xl border border-destructive/20 bg-destructive/10 p-4 text-sm text-destructive">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>Your session tokens are depleted. Top up below so customers can access your shop.</span>
                </div>
              )}

              {!shopCode.activation_fee_paid && (
                <div className="space-y-3 rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4">
                  <div className="flex items-start gap-2 text-sm text-amber-700">
                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                    <div>
                      <p className="font-semibold">Activation required</p>
                      <p className="mt-0.5">
                        One-time fee: <strong>GHS {activationFee.toFixed(2)}</strong>
                        {walletBalance !== null && (
                          <span className="ml-2 text-muted-foreground">· Wallet: GHS {walletBalance.toFixed(2)}</span>
                        )}
                      </p>
                    </div>
                  </div>
                  <Button
                    disabled={activating || (walletBalance !== null && walletBalance < activationFee)}
                    onClick={handleActivate}
                    className="w-full bg-amber-500 hover:bg-amber-500/90 text-white"
                  >
                    {activating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wallet className="w-4 h-4" />}
                    Activate with Wallet
                  </Button>
                  {walletBalance !== null && walletBalance < activationFee && activationFee > 0 && (
                    <p className="text-xs text-destructive">Insufficient wallet balance. Top up your wallet first.</p>
                  )}
                </div>
              )}

              {/* Buy Sessions */}
              {shopCode.activation_fee_paid && (
                <Card className="border-[#1b388b]/20 bg-[#1b388b]/5">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base text-[#1b388b] flex items-center gap-2">
                      <Coins className="w-4 h-4" />
                      Buy Sessions
                    </CardTitle>
                    <CardDescription className="text-[#1b388b]">
                      Each session = one customer entering your shop code.
                      {sessionPrice > 0 && ` GHS ${sessionPrice.toFixed(2)} per session.`}
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div className="flex gap-2 items-end">
                      <div className="flex-1 space-y-1">
                        <label className="text-xs text-[#1b388b]">
                          Number of sessions ({minSessions}–{maxSessions})
                        </label>
                        <input
                          type="number"
                          min={minSessions}
                          max={maxSessions}
                          placeholder={`Min ${minSessions}`}
                          value={sessionQty}
                          onChange={e => setSessionQty(e.target.value)}
                          className="w-full rounded-xl border border-white/60 dark:border-white/5 bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#1b388b] clay-inset"
                        />
                      </div>
                      {sessionPrice > 0 && sessionQty && parseInt(sessionQty) >= minSessions && (
                        <div className="text-sm text-[#1b388b] font-bold pb-2 shrink-0">
                          = GHS {(sessionPrice * (parseInt(sessionQty) || 0)).toFixed(2)}
                        </div>
                      )}
                    </div>
                    <Button
                      disabled={buyingSessions || !sessionQty || parseInt(sessionQty) < minSessions || (walletBalance !== null && walletBalance < sessionPrice * (parseInt(sessionQty) || 0))}
                      onClick={handleBuySessions}
                      className="w-full bg-[#1b388b] hover:bg-[#1b388b]/90 text-white"
                    >
                      {buyingSessions ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wallet className="w-4 h-4" />}
                      Buy with Wallet
                    </Button>
                    {walletBalance !== null && (
                      <p className="text-xs text-muted-foreground">Wallet balance: GHS {walletBalance.toFixed(2)}</p>
                    )}
                  </CardContent>
                </Card>
              )}

              {/* USSD Display Name */}
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base flex items-center gap-2">
                    <Tag className="w-4 h-4 text-[#1b388b]" />
                    USSD Display Name
                  </CardTitle>
                  <CardDescription>
                    Optional — overrides your shop name on USSD and WhatsApp bot screens only. Clear it to revert.
                    {!displayNameInput && shopName && ` Currently showing: "${shopName}"`}
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-2">
                  <input
                    type="text"
                    maxLength={30}
                    placeholder={shopName || "Shop"}
                    value={displayNameInput}
                    onChange={e => { setDisplayNameInput(e.target.value); setDisplayNameError(null) }}
                    className="w-full rounded-xl border border-white/60 dark:border-white/5 bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#1b388b] clay-inset"
                  />
                  {displayNameError && <p className="text-xs text-destructive">{displayNameError}</p>}
                  <Button
                    size="sm"
                    disabled={savingDisplayName}
                    onClick={handleSaveDisplayName}
                    className="w-full bg-[#1b388b] hover:bg-[#1b388b]/90 text-white"
                  >
                    {savingDisplayName ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : null}
                    {displayNameInput.trim() ? "Save" : "Clear"}
                  </Button>
                </CardContent>
              </Card>

              {/* How It Works */}
              {dialCode && (
                <Card>
                  <CardHeader className="pb-3">
                    <CardTitle className="text-base">How Your Customers Use It</CardTitle>
                    <CardDescription>Share these instructions with your customers</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="bg-muted/40 rounded-xl p-4 space-y-3 font-mono text-sm">
                      <p className="text-muted-foreground text-xs font-sans uppercase tracking-wide mb-4">Step-by-step</p>
                      <div className="flex items-start gap-3">
                        <span className="bg-[#1b388b] text-white text-xs font-bold rounded-full w-5 h-5 flex items-center justify-center shrink-0 mt-0.5 font-sans">1</span>
                        <div>
                          <p className="text-foreground font-sans">Dial the USSD code</p>
                          <p className="text-[#1b388b] font-bold text-lg mt-0.5">{dialCode}</p>
                        </div>
                      </div>
                      <div className="flex items-start gap-3">
                        <span className="bg-[#1b388b] text-white text-xs font-bold rounded-full w-5 h-5 flex items-center justify-center shrink-0 mt-0.5 font-sans">2</span>
                        <div>
                          <p className="text-foreground font-sans">Enter your shop code when prompted</p>
                          <p className="text-[#1b388b] font-bold text-lg mt-0.5">{shopCode.code}</p>
                        </div>
                      </div>
                      <div className="flex items-start gap-3">
                        <span className="bg-[#1b388b] text-white text-xs font-bold rounded-full w-5 h-5 flex items-center justify-center shrink-0 mt-0.5 font-sans">3</span>
                        <p className="text-foreground font-sans">Select a network, pick a bundle, and enter the recipient's number</p>
                      </div>
                      <div className="flex items-start gap-3">
                        <span className="bg-[#1b388b] text-white text-xs font-bold rounded-full w-5 h-5 flex items-center justify-center shrink-0 mt-0.5 font-sans">4</span>
                        <p className="text-foreground font-sans">Approve the MoMo prompt on their phone to complete payment</p>
                      </div>
                    </div>

                    <div className="mt-4 p-3 bg-[#1b388b]/5 border border-[#1b388b]/20 rounded-lg">
                      <p className="text-sm font-medium text-[#1b388b] mb-1">Share with your customers:</p>
                      <p className="text-sm text-[#1b388b]">
                        "Dial <strong>{dialCode}</strong> on your phone, enter shop code <strong>{shopCode.code}</strong>, and buy your data bundle instantly!"
                      </p>
                    </div>
                  </CardContent>
                </Card>
              )}

              {/* Orders */}
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">Recent Orders</CardTitle>
                  <CardDescription>Orders placed through your USSD shop code</CardDescription>
                </CardHeader>
                <CardContent>
                  {orders.length === 0 ? (
                    <div className="text-center py-8 text-muted-foreground text-sm">
                      No orders yet. Share your shop code with customers to get started.
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {orders.map(order => (
                        <div key={order.id} className="flex items-center justify-between py-2 border-b last:border-0">
                          <div>
                            <p className="text-sm font-medium text-foreground">
                              {order.package_size} <span className="text-muted-foreground">{order.network}</span>
                            </p>
                            <p className="text-xs text-muted-foreground">
                              To: {order.recipient_phone} · {new Date(order.created_at).toLocaleDateString()}
                            </p>
                          </div>
                          <div className="text-right">
                            <p className="text-sm font-medium text-foreground">GHS {Number(order.amount).toFixed(2)}</p>
                            {orderStatusBadge(order.order_status)}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="whatsapp" className="space-y-5">
              {/* WhatsApp hero */}
              <div className="rounded-2xl bg-gradient-to-br from-[#1b388b] to-[#2a5ce8] p-5 text-white">
                <div className="flex items-center justify-between">
                  <p className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-white/80">
                    <MessageCircle className="h-3.5 w-3.5" /> WhatsApp Shop Bot
                  </p>
                  {shopCode.whatsapp_activated ? (
                    <span className="rounded-full bg-white/20 px-2.5 py-1 text-xs font-bold">Active</span>
                  ) : (
                    <span className="rounded-full bg-white/10 px-2.5 py-1 text-xs font-bold text-white/70">Not Activated</span>
                  )}
                </div>

                {!shopCode.whatsapp_activated ? (
                  <p className="mt-3 text-sm text-white/80">Let customers order Data, Airtime, and Results Checker vouchers straight from WhatsApp.</p>
                ) : waLink ? (
                  <>
                    <p className="mt-3 text-xs uppercase tracking-wide text-white/70">Your WhatsApp shop link</p>
                    <div className="mt-1.5 flex items-center gap-2">
                      <div className="flex-1 truncate rounded-xl border border-white/20 bg-white/10 px-3 py-2 font-mono text-sm">
                        {waLink}
                      </div>
                      <button
                        onClick={copyWaLink}
                        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-white/20 bg-white/10 hover:bg-white/20"
                      >
                        {waLinkCopied ? <CheckCircle className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                      </button>
                    </div>
                    {shopCode.whatsapp_activated_at && (
                      <p className="mt-2 text-xs text-white/60">Activated {new Date(shopCode.whatsapp_activated_at).toLocaleDateString()}</p>
                    )}
                  </>
                ) : (
                  <p className="mt-3 flex items-start gap-2 text-sm text-white/80">
                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                    WhatsApp number not yet configured. Check back soon — your shop's WhatsApp link will appear here once it's live.
                  </p>
                )}
              </div>

              {!shopCode.whatsapp_activated && (
                <div className="space-y-3 rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4">
                  <div className="flex items-start gap-2 text-sm text-amber-700">
                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                    <div>
                      <p className="font-semibold">Activation required</p>
                      <p className="mt-0.5">
                        One-time fee: <strong>GHS {whatsappFee.toFixed(2)}</strong>
                        {walletBalance !== null && (
                          <span className="ml-2 text-muted-foreground">· Wallet: GHS {walletBalance.toFixed(2)}</span>
                        )}
                      </p>
                    </div>
                  </div>
                  <Button
                    disabled={whatsappActivating || whatsappFee <= 0 || (walletBalance !== null && walletBalance < whatsappFee)}
                    onClick={handleActivateWhatsapp}
                    className="w-full bg-amber-500 hover:bg-amber-500/90 text-white"
                  >
                    {whatsappActivating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wallet className="w-4 h-4" />}
                    Activate WhatsApp Shop
                  </Button>
                  {whatsappFee <= 0 && (
                    <p className="text-xs text-muted-foreground">WhatsApp shop activation isn't available yet — check back soon.</p>
                  )}
                  {whatsappFee > 0 && walletBalance !== null && walletBalance < whatsappFee && (
                    <p className="text-xs text-destructive">Insufficient wallet balance. Top up your wallet first.</p>
                  )}
                </div>
              )}

              {/* How It Works — only meaningful once activated */}
              {shopCode.whatsapp_activated && (
                <Card>
                  <CardHeader className="pb-3">
                    <CardTitle className="text-base">How Your Customers Use It</CardTitle>
                    <CardDescription>Share these instructions with your customers</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="bg-muted/40 rounded-xl p-4 space-y-3 font-mono text-sm">
                      <p className="text-muted-foreground text-xs font-sans uppercase tracking-wide mb-4">Step-by-step</p>
                      <div className="flex items-start gap-3">
                        <span className="bg-[#1b388b] text-white text-xs font-bold rounded-full w-5 h-5 flex items-center justify-center shrink-0 mt-0.5 font-sans">1</span>
                        <div>
                          <p className="text-foreground font-sans">Tap your shop link{waLink ? "" : " (once your number is set up)"}, or open WhatsApp and message</p>
                          <p className="text-[#1b388b] font-bold text-lg mt-0.5">{whatsappShopNumber || "—"}</p>
                        </div>
                      </div>
                      <div className="flex items-start gap-3">
                        <span className="bg-[#1b388b] text-white text-xs font-bold rounded-full w-5 h-5 flex items-center justify-center shrink-0 mt-0.5 font-sans">2</span>
                        <div>
                          <p className="text-foreground font-sans">Send your shop code to start (pre-filled automatically if they tapped the link)</p>
                          <p className="text-[#1b388b] font-bold text-lg mt-0.5">{shopCode.code}</p>
                        </div>
                      </div>
                      <div className="flex items-start gap-3">
                        <span className="bg-[#1b388b] text-white text-xs font-bold rounded-full w-5 h-5 flex items-center justify-center shrink-0 mt-0.5 font-sans">3</span>
                        <p className="text-foreground font-sans">Pick Data, Airtime, or Results Checker, then follow the prompts to choose a bundle and recipient</p>
                      </div>
                      <div className="flex items-start gap-3">
                        <span className="bg-[#1b388b] text-white text-xs font-bold rounded-full w-5 h-5 flex items-center justify-center shrink-0 mt-0.5 font-sans">4</span>
                        <p className="text-foreground font-sans">Approve the MoMo prompt on their phone to complete payment</p>
                      </div>
                    </div>

                    <div className="mt-4 p-3 bg-[#1b388b]/5 border border-[#1b388b]/20 rounded-lg">
                      <p className="text-sm font-medium text-[#1b388b] mb-1">Share with your customers:</p>
                      <p className="text-sm text-[#1b388b]">
                        {waLink
                          ? <>"Tap this link to order on WhatsApp: <strong>{waLink}</strong>"</>
                          : <>"Message us on WhatsApp and send shop code <strong>{shopCode.code}</strong> to buy your data bundle instantly!"</>}
                      </p>
                    </div>
                  </CardContent>
                </Card>
              )}
            </TabsContent>
          </Tabs>
        )}
      </div>
    </DashboardLayout>
  )
}
