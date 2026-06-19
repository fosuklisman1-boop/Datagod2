"use client"

import { useEffect, useState } from "react"
import { useAuth } from "@/lib/auth-context"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { supabase } from "@/lib/supabase"
import { Smartphone, Hash, Coins, Copy, CheckCircle, RefreshCw, AlertCircle, Wallet, Loader2 } from "lucide-react"
import { toast } from "sonner"

interface UssdShopCode {
  id: string
  code: string
  status: 'inactive' | 'active' | 'suspended'
  token_balance: number
  activation_fee_paid: boolean
  created_at: string
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

  useEffect(() => {
    if (!user) return
    loadData()
  }, [user])

  const loadData = async () => {
    setLoading(true)
    try {
      const { data: shopRow } = await supabase
        .from("user_shops")
        .select("id")
        .eq("user_id", user!.id)
        .single()

      if (!shopRow) { setLoading(false); return }

      // app_settings is service-role only; read ussd config via curated public API.
      const [codeRes, cfgRes, ordersRes, walletRes] = await Promise.all([
        supabase
          .from("ussd_shop_codes")
          .select("id, code, status, token_balance, activation_fee_paid, created_at")
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

  const copyCode = () => {
    if (!shopCode) return
    navigator.clipboard.writeText(shopCode.code)
    setCopied(true)
    toast.success("Shop code copied!")
    setTimeout(() => setCopied(false), 2000)
  }

  const statusBadge = (status: string, tokenBalance: number) => {
    if (status === 'suspended') return <Badge className="bg-warning/10 text-warning border-border">Suspended</Badge>
    if (status === 'active' && tokenBalance === 0) return <Badge className="bg-warning/10 text-warning border-border">No Sessions</Badge>
    if (status === 'active') return <Badge className="bg-success/15 text-success border-border">Active</Badge>
    return <Badge className="bg-muted text-muted-foreground border-border">Inactive</Badge>
  }

  const orderStatusBadge = (status: string) => {
    if (status === 'completed') return <Badge className="bg-success/15 text-success text-xs">Completed</Badge>
    if (status === 'failed') return <Badge className="bg-destructive/15 text-destructive text-xs">Failed</Badge>
    if (status === 'processing') return <Badge className="bg-primary/10 text-primary text-xs">Processing</Badge>
    return <Badge className="bg-muted text-muted-foreground text-xs">Pending</Badge>
  }

  if (loading) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center h-64 text-muted-foreground">Loading...</div>
      </DashboardLayout>
    )
  }

  return (
    <DashboardLayout>
      <div className="p-4 sm:p-6 max-w-3xl mx-auto space-y-6">

        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold text-foreground flex items-center gap-2">
              <Smartphone className="w-5 h-5 text-primary" />
              USSD Storefront
            </h1>
            <p className="text-sm text-muted-foreground mt-1">Let your customers buy data bundles by dialing a USSD code</p>
          </div>
          <Button variant="outline" size="sm" onClick={loadData}>
            <RefreshCw className="w-4 h-4" />
          </Button>
        </div>

        {!shopCode ? (
          <Card className="border-dashed border-2 border-border">
            <CardContent className="py-12 text-center text-muted-foreground">
              <Hash className="w-10 h-10 mx-auto mb-3 opacity-40" />
              <p className="font-medium text-muted-foreground">No USSD code assigned yet</p>
              <p className="text-sm mt-1">Contact admin to get your shop's USSD code set up.</p>
            </CardContent>
          </Card>
        ) : (
          <>
            {/* Shop Code Card */}
            <Card className="border-primary/20 bg-card">
              <CardHeader className="pb-2">
                <CardTitle className="text-base text-primary flex items-center justify-between">
                  <span className="flex items-center gap-2">
                    <Hash className="w-4 h-4" />
                    Your Shop Code
                  </span>
                  {statusBadge(shopCode.status, shopCode.token_balance)}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex items-center gap-4 mt-1">
                  <div className="bg-card border-2 border-primary/20 rounded-xl px-6 py-4 flex-1 text-center shadow-sm">
                    <span className="text-4xl font-black tracking-widest text-primary font-mono">
                      {shopCode.code}
                    </span>
                    <p className="text-xs text-muted-foreground mt-1">Enter this code on the USSD prompt</p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={copyCode}
                    className="shrink-0 border-primary/20 text-primary hover:bg-primary/10"
                  >
                    {copied ? <CheckCircle className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                  </Button>
                </div>

                <div className="flex items-center gap-3 mt-4 pt-4 border-t border-primary/20">
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Coins className="w-4 h-4 text-primary" />
                    <span>
                      <strong className={shopCode.token_balance <= 5 ? 'text-destructive' : 'text-foreground'}>
                        {shopCode.token_balance}
                      </strong>
                      {' '}session{shopCode.token_balance !== 1 ? 's' : ''} remaining
                    </span>
                    {shopCode.token_balance <= 5 && shopCode.token_balance > 0 && (
                      <Badge className="bg-destructive/15 text-destructive text-xs ml-1">Low</Badge>
                    )}
                    {shopCode.token_balance === 0 && (
                      <Badge className="bg-destructive/15 text-destructive text-xs ml-1">Depleted</Badge>
                    )}
                  </div>
                </div>

                {shopCode.token_balance === 0 && shopCode.activation_fee_paid && (
                  <div className="mt-3 flex items-start gap-2 p-3 bg-destructive/10 border border-border rounded-lg text-sm text-destructive">
                    <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                    <span>Your session tokens are depleted. Top up below so customers can access your shop.</span>
                  </div>
                )}

                {!shopCode.activation_fee_paid && (
                  <div className="mt-3 p-4 bg-warning/10 border border-border rounded-lg space-y-3">
                    <div className="flex items-start gap-2 text-sm text-warning">
                      <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                      <div>
                        <p className="font-medium">Activation required</p>
                        <p className="text-warning mt-0.5">
                          One-time fee: <strong>GHS {activationFee.toFixed(2)}</strong>
                          {walletBalance !== null && (
                            <span className="ml-2 text-muted-foreground">· Wallet: GHS {walletBalance.toFixed(2)}</span>
                          )}
                        </p>
                      </div>
                    </div>
                    <Button
                      size="sm"
                      disabled={activating || (walletBalance !== null && walletBalance < activationFee)}
                      onClick={handleActivate}
                      className="w-full bg-warning hover:bg-warning/90 text-white"
                    >
                      {activating ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <Wallet className="w-3 h-3 mr-1" />}
                      Activate with Wallet
                    </Button>
                    {walletBalance !== null && walletBalance < activationFee && activationFee > 0 && (
                      <p className="text-xs text-destructive">Insufficient wallet balance. Top up your wallet first.</p>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Buy Sessions */}
            {shopCode.activation_fee_paid && (
              <Card className="border-border bg-primary/10">
                <CardHeader className="pb-2">
                  <CardTitle className="text-base text-primary flex items-center gap-2">
                    <Coins className="w-4 h-4" />
                    Buy Sessions
                  </CardTitle>
                  <CardDescription className="text-primary">
                    Each session = one customer entering your shop code.
                    {sessionPrice > 0 && ` GHS ${sessionPrice.toFixed(2)} per session.`}
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex gap-2 items-end">
                    <div className="flex-1 space-y-1">
                      <label className="text-xs text-primary">
                        Number of sessions ({minSessions}–{maxSessions})
                      </label>
                      <input
                        type="number"
                        min={minSessions}
                        max={maxSessions}
                        placeholder={`Min ${minSessions}`}
                        value={sessionQty}
                        onChange={e => setSessionQty(e.target.value)}
                        className="w-full border border-border rounded-md px-3 py-2 text-sm bg-card focus:outline-none focus:ring-2 focus:ring-primary"
                      />
                    </div>
                    {sessionPrice > 0 && sessionQty && parseInt(sessionQty) >= minSessions && (
                      <div className="text-sm text-primary font-medium pb-2 shrink-0">
                        = GHS {(sessionPrice * (parseInt(sessionQty) || 0)).toFixed(2)}
                      </div>
                    )}
                  </div>
                  <Button
                    size="sm"
                    disabled={buyingSessions || !sessionQty || parseInt(sessionQty) < minSessions || (walletBalance !== null && walletBalance < sessionPrice * (parseInt(sessionQty) || 0))}
                    onClick={handleBuySessions}
                    className="w-full bg-primary hover:bg-primary text-white"
                  >
                    {buyingSessions ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <Wallet className="w-3 h-3 mr-1" />}
                    Buy with Wallet
                  </Button>
                  {walletBalance !== null && (
                    <p className="text-xs text-muted-foreground">Wallet balance: GHS {walletBalance.toFixed(2)}</p>
                  )}
                </CardContent>
              </Card>
            )}

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
                      <span className="bg-primary text-white text-xs font-bold rounded-full w-5 h-5 flex items-center justify-center shrink-0 mt-0.5 font-sans">1</span>
                      <div>
                        <p className="text-foreground font-sans">Dial the USSD code</p>
                        <p className="text-primary font-bold text-lg mt-0.5">{dialCode}</p>
                      </div>
                    </div>
                    <div className="flex items-start gap-3">
                      <span className="bg-primary text-white text-xs font-bold rounded-full w-5 h-5 flex items-center justify-center shrink-0 mt-0.5 font-sans">2</span>
                      <div>
                        <p className="text-foreground font-sans">Enter your shop code when prompted</p>
                        <p className="text-primary font-bold text-lg mt-0.5">{shopCode.code}</p>
                      </div>
                    </div>
                    <div className="flex items-start gap-3">
                      <span className="bg-primary text-white text-xs font-bold rounded-full w-5 h-5 flex items-center justify-center shrink-0 mt-0.5 font-sans">3</span>
                      <p className="text-foreground font-sans">Select a network, pick a bundle, and enter the recipient's number</p>
                    </div>
                    <div className="flex items-start gap-3">
                      <span className="bg-primary text-white text-xs font-bold rounded-full w-5 h-5 flex items-center justify-center shrink-0 mt-0.5 font-sans">4</span>
                      <p className="text-foreground font-sans">Approve the MoMo prompt on their phone to complete payment</p>
                    </div>
                  </div>

                  <div className="mt-4 p-3 bg-primary/5 border border-primary/20 rounded-lg">
                    <p className="text-sm font-medium text-primary mb-1">Share with your customers:</p>
                    <p className="text-sm text-primary">
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
          </>
        )}
      </div>
    </DashboardLayout>
  )
}
