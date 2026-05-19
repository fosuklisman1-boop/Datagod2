"use client"

import { useEffect, useState } from "react"
import { useAuth } from "@/lib/auth-context"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { supabase } from "@/lib/supabase"
import { Smartphone, Hash, Coins, Copy, CheckCircle, RefreshCw, AlertCircle, Wallet, CreditCard, Loader2 } from "lucide-react"
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
      // Find the user's shop
      const { data: shopRow } = await supabase
        .from("user_shops")
        .select("id")
        .eq("user_id", user!.id)
        .single()

      if (!shopRow) { setLoading(false); return }

      const [codeRes, settingsRes, ordersRes] = await Promise.all([
        supabase
          .from("ussd_shop_codes")
          .select("id, code, status, token_balance, activation_fee_paid, created_at")
          .eq("shop_id", shopRow.id)
          .maybeSingle(),
        supabase
          .from("app_settings")
          .select("ussd_shop_dial_code, ussd_shop_activation_fee, ussd_shop_session_price, ussd_shop_min_sessions, ussd_shop_max_sessions")
          .limit(1)
          .maybeSingle(),
        supabase
          .from("ussd_shop_orders")
          .select("id, dialing_phone, recipient_phone, network, package_size, amount, order_status, payment_status, created_at")
          .eq("shop_id", shopRow.id)
          .order("created_at", { ascending: false })
          .limit(20),
      ])

      setShopCode(codeRes.data ?? null)
      setDialCode(settingsRes.data?.ussd_shop_dial_code ?? "")
      setActivationFee(Number(settingsRes.data?.ussd_shop_activation_fee ?? 0))
      setSessionPrice(Number(settingsRes.data?.ussd_shop_session_price ?? 0))
      setMinSessions(Number(settingsRes.data?.ussd_shop_min_sessions ?? 1))
      setMaxSessions(Number(settingsRes.data?.ussd_shop_max_sessions ?? 100))
      setOrders(ordersRes.data ?? [])

      // Fetch wallet balance for activation payment
      const { data: walletRow } = await supabase
        .from("wallets")
        .select("balance")
        .eq("user_id", user!.id)
        .maybeSingle()
      setWalletBalance(walletRow ? Number(walletRow.balance) : null)
    } catch (e) {
      toast.error("Failed to load USSD data")
    } finally {
      setLoading(false)
    }
  }

  const handleActivate = async (paymentMethod: 'wallet' | 'momo') => {
    setActivating(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const res = await fetch("/api/dashboard/ussd-shop/activate", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token}` },
        body: JSON.stringify({ payment_method: paymentMethod }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? "Activation failed")
      if (paymentMethod === 'wallet') {
        toast.success("Shop code activated!")
        await loadData()
      } else {
        toast.success("MoMo prompt sent. Your code will activate on payment confirmation.")
      }
    } catch (err: any) {
      toast.error(err.message ?? "Activation failed")
    } finally {
      setActivating(false)
    }
  }

  const handleBuySessions = async (paymentMethod: 'wallet' | 'momo') => {
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
        body: JSON.stringify({ sessions: qty, payment_method: paymentMethod }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? "Purchase failed")
      if (paymentMethod === 'wallet') {
        toast.success(`${qty} sessions added!`)
        setSessionQty("")
        await loadData()
      } else {
        toast.success(json.message ?? "MoMo prompt sent.")
        setSessionQty("")
      }
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
    if (status === 'suspended') return <Badge className="bg-yellow-100 text-yellow-800 border-yellow-200">Suspended</Badge>
    if (status === 'active' && tokenBalance === 0) return <Badge className="bg-orange-100 text-orange-700 border-orange-200">No Sessions</Badge>
    if (status === 'active') return <Badge className="bg-green-100 text-green-800 border-green-200">Active</Badge>
    return <Badge className="bg-gray-100 text-gray-600 border-gray-200">Inactive</Badge>
  }

  const orderStatusBadge = (status: string) => {
    if (status === 'completed') return <Badge className="bg-green-100 text-green-800 text-xs">Completed</Badge>
    if (status === 'failed') return <Badge className="bg-red-100 text-red-800 text-xs">Failed</Badge>
    if (status === 'processing') return <Badge className="bg-blue-100 text-blue-800 text-xs">Processing</Badge>
    return <Badge className="bg-gray-100 text-gray-600 text-xs">Pending</Badge>
  }

  if (loading) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center h-64 text-gray-500">Loading...</div>
      </DashboardLayout>
    )
  }

  return (
    <DashboardLayout>
      <div className="p-4 sm:p-6 max-w-3xl mx-auto space-y-6">

        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold text-gray-900 flex items-center gap-2">
              <Smartphone className="w-5 h-5 text-blue-600" />
              USSD Storefront
            </h1>
            <p className="text-sm text-gray-500 mt-1">Let your customers buy data bundles by dialing a USSD code</p>
          </div>
          <Button variant="outline" size="sm" onClick={loadData}>
            <RefreshCw className="w-4 h-4" />
          </Button>
        </div>

        {!shopCode ? (
          <Card className="border-dashed border-2 border-gray-200">
            <CardContent className="py-12 text-center text-gray-400">
              <Hash className="w-10 h-10 mx-auto mb-3 opacity-40" />
              <p className="font-medium text-gray-600">No USSD code assigned yet</p>
              <p className="text-sm mt-1">Contact admin to get your shop's USSD code set up.</p>
            </CardContent>
          </Card>
        ) : (
          <>
            {/* Shop Code Card */}
            <Card className="border-blue-200 bg-gradient-to-br from-blue-50 to-indigo-50">
              <CardHeader className="pb-2">
                <CardTitle className="text-base text-blue-800 flex items-center justify-between">
                  <span className="flex items-center gap-2">
                    <Hash className="w-4 h-4" />
                    Your Shop Code
                  </span>
                  {statusBadge(shopCode.status, shopCode.token_balance)}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex items-center gap-4 mt-1">
                  <div className="bg-white border-2 border-blue-200 rounded-xl px-6 py-4 flex-1 text-center shadow-sm">
                    <span className="text-4xl font-black tracking-widest text-blue-700 font-mono">
                      {shopCode.code}
                    </span>
                    <p className="text-xs text-gray-400 mt-1">Enter this code on the USSD prompt</p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={copyCode}
                    className="shrink-0 border-blue-200 text-blue-700 hover:bg-blue-100"
                  >
                    {copied ? <CheckCircle className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                  </Button>
                </div>

                <div className="flex items-center gap-3 mt-4 pt-4 border-t border-blue-100">
                  <div className="flex items-center gap-2 text-sm text-gray-600">
                    <Coins className="w-4 h-4 text-blue-500" />
                    <span>
                      <strong className={shopCode.token_balance <= 5 ? 'text-red-600' : 'text-gray-800'}>
                        {shopCode.token_balance}
                      </strong>
                      {' '}session{shopCode.token_balance !== 1 ? 's' : ''} remaining
                    </span>
                    {shopCode.token_balance <= 5 && shopCode.token_balance > 0 && (
                      <Badge className="bg-red-100 text-red-700 text-xs ml-1">Low</Badge>
                    )}
                    {shopCode.token_balance === 0 && (
                      <Badge className="bg-red-100 text-red-700 text-xs ml-1">Depleted</Badge>
                    )}
                  </div>
                </div>

                {shopCode.token_balance === 0 && (
                  <div className="mt-3 flex items-start gap-2 p-3 bg-red-50 border border-red-100 rounded-lg text-sm text-red-700">
                    <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                    <span>Your session tokens are depleted. Contact admin to top up so customers can access your shop.</span>
                  </div>
                )}

                {!shopCode.activation_fee_paid && (
                  <div className="mt-3 p-4 bg-yellow-50 border border-yellow-200 rounded-lg space-y-3">
                    <div className="flex items-start gap-2 text-sm text-yellow-800">
                      <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                      <div>
                        <p className="font-medium">Activation required</p>
                        <p className="text-yellow-700 mt-0.5">
                          One-time fee: <strong>GHS {activationFee.toFixed(2)}</strong>
                          {walletBalance !== null && (
                            <span className="ml-2 text-gray-500">· Wallet: GHS {walletBalance.toFixed(2)}</span>
                          )}
                        </p>
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        disabled={activating || (walletBalance !== null && walletBalance < activationFee)}
                        onClick={() => handleActivate('wallet')}
                        className="flex-1 bg-yellow-600 hover:bg-yellow-700 text-white"
                      >
                        {activating ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <Wallet className="w-3 h-3 mr-1" />}
                        Pay with Wallet
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={activating}
                        onClick={() => handleActivate('momo')}
                        className="flex-1 border-yellow-300 text-yellow-800 hover:bg-yellow-100"
                      >
                        {activating ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <CreditCard className="w-3 h-3 mr-1" />}
                        Pay with MoMo
                      </Button>
                    </div>
                    {walletBalance !== null && walletBalance < activationFee && activationFee > 0 && (
                      <p className="text-xs text-red-600">Insufficient wallet balance. Use MoMo or top up your wallet first.</p>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Buy Sessions */}
            {shopCode.activation_fee_paid && (
              <Card className="border-indigo-200 bg-indigo-50">
                <CardHeader className="pb-2">
                  <CardTitle className="text-base text-indigo-800 flex items-center gap-2">
                    <Coins className="w-4 h-4" />
                    Buy Sessions
                  </CardTitle>
                  <CardDescription className="text-indigo-600">
                    Each session = one customer entering your shop code.
                    {sessionPrice > 0 && ` GHS ${sessionPrice.toFixed(2)} per session.`}
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex gap-2 items-end">
                    <div className="flex-1 space-y-1">
                      <label className="text-xs text-indigo-700">
                        Number of sessions ({minSessions}–{maxSessions})
                      </label>
                      <input
                        type="number"
                        min={minSessions}
                        max={maxSessions}
                        placeholder={`Min ${minSessions}`}
                        value={sessionQty}
                        onChange={e => setSessionQty(e.target.value)}
                        className="w-full border border-indigo-200 rounded-md px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-indigo-400"
                      />
                    </div>
                    {sessionPrice > 0 && sessionQty && parseInt(sessionQty) >= minSessions && (
                      <div className="text-sm text-indigo-700 font-medium pb-2 shrink-0">
                        = GHS {(sessionPrice * (parseInt(sessionQty) || 0)).toFixed(2)}
                      </div>
                    )}
                  </div>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      disabled={buyingSessions || (walletBalance !== null && walletBalance < sessionPrice * (parseInt(sessionQty) || 0))}
                      onClick={() => handleBuySessions('wallet')}
                      className="flex-1 bg-indigo-600 hover:bg-indigo-700 text-white"
                    >
                      {buyingSessions ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <Wallet className="w-3 h-3 mr-1" />}
                      Wallet
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={buyingSessions}
                      onClick={() => handleBuySessions('momo')}
                      className="flex-1 border-indigo-300 text-indigo-800 hover:bg-indigo-100"
                    >
                      {buyingSessions ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <CreditCard className="w-3 h-3 mr-1" />}
                      MoMo
                    </Button>
                  </div>
                  {walletBalance !== null && (
                    <p className="text-xs text-gray-500">Wallet balance: GHS {walletBalance.toFixed(2)}</p>
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
                  <div className="bg-gray-50 rounded-xl p-4 space-y-3 font-mono text-sm">
                    <p className="text-gray-500 text-xs font-sans uppercase tracking-wide mb-4">Step-by-step</p>
                    <div className="flex items-start gap-3">
                      <span className="bg-blue-600 text-white text-xs font-bold rounded-full w-5 h-5 flex items-center justify-center shrink-0 mt-0.5 font-sans">1</span>
                      <div>
                        <p className="text-gray-700 font-sans">Dial the USSD code</p>
                        <p className="text-blue-700 font-bold text-lg mt-0.5">{dialCode}</p>
                      </div>
                    </div>
                    <div className="flex items-start gap-3">
                      <span className="bg-blue-600 text-white text-xs font-bold rounded-full w-5 h-5 flex items-center justify-center shrink-0 mt-0.5 font-sans">2</span>
                      <div>
                        <p className="text-gray-700 font-sans">Enter your shop code when prompted</p>
                        <p className="text-blue-700 font-bold text-lg mt-0.5">{shopCode.code}</p>
                      </div>
                    </div>
                    <div className="flex items-start gap-3">
                      <span className="bg-blue-600 text-white text-xs font-bold rounded-full w-5 h-5 flex items-center justify-center shrink-0 mt-0.5 font-sans">3</span>
                      <p className="text-gray-700 font-sans">Select a network, pick a bundle, and enter the recipient's number</p>
                    </div>
                    <div className="flex items-start gap-3">
                      <span className="bg-blue-600 text-white text-xs font-bold rounded-full w-5 h-5 flex items-center justify-center shrink-0 mt-0.5 font-sans">4</span>
                      <p className="text-gray-700 font-sans">Approve the MoMo prompt on their phone to complete payment</p>
                    </div>
                  </div>

                  <div className="mt-4 p-3 bg-blue-50 border border-blue-100 rounded-lg">
                    <p className="text-sm font-medium text-blue-800 mb-1">Share with your customers:</p>
                    <p className="text-sm text-blue-700">
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
                  <div className="text-center py-8 text-gray-400 text-sm">
                    No orders yet. Share your shop code with customers to get started.
                  </div>
                ) : (
                  <div className="space-y-2">
                    {orders.map(order => (
                      <div key={order.id} className="flex items-center justify-between py-2 border-b last:border-0">
                        <div>
                          <p className="text-sm font-medium text-gray-800">
                            {order.package_size} <span className="text-gray-400">{order.network}</span>
                          </p>
                          <p className="text-xs text-gray-400">
                            To: {order.recipient_phone} · {new Date(order.created_at).toLocaleDateString()}
                          </p>
                        </div>
                        <div className="text-right">
                          <p className="text-sm font-medium text-gray-800">GHS {Number(order.amount).toFixed(2)}</p>
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
