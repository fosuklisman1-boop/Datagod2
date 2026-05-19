"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { supabase } from "@/lib/supabase"
import { toast } from "sonner"
import { Plus, Coins, CheckCircle, PauseCircle, Trash2, RefreshCw, Hash, Settings2, Save } from "lucide-react"

interface ShopCode {
  id: string
  code: string
  status: 'inactive' | 'active' | 'suspended'
  token_balance: number
  activation_fee_paid: boolean
  activation_paid_at: string | null
  created_at: string
  shop_id: string
  shop_name: string
  shop_owner_user_id: string
  order_count: number
}

interface ShopOrder {
  id: string
  shop_code_id: string
  dialing_phone: string
  recipient_phone: string
  network: string
  package_size: string
  amount: number
  order_status: string
  payment_status: string
  created_at: string
  shop_name?: string
  code?: string
}

interface UserShop {
  id: string
  shop_name: string
}

export default function AdminUssdShopsPage() {
  const router = useRouter()
  const [codes, setCodes] = useState<ShopCode[]>([])
  const [orders, setOrders] = useState<ShopOrder[]>([])
  const [userShops, setUserShops] = useState<UserShop[]>([])
  const [loading, setLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState("")

  // Create modal
  const [showCreate, setShowCreate] = useState(false)
  const [createShopId, setCreateShopId] = useState("")
  const [createCode, setCreateCode] = useState("")
  const [createTokens, setCreateTokens] = useState("0")
  const [creating, setCreating] = useState(false)

  // Tokens modal
  const [showTokens, setShowTokens] = useState(false)
  const [tokensTarget, setTokensTarget] = useState<ShopCode | null>(null)
  const [tokenQty, setTokenQty] = useState("10")
  const [tokenAmount, setTokenAmount] = useState("")
  const [tokenMethod, setTokenMethod] = useState<"wallet" | "momo">("wallet")
  const [addingTokens, setAddingTokens] = useState(false)

  // USSD dial code setting
  const [dialCode, setDialCode] = useState("")
  const [savingDialCode, setSavingDialCode] = useState(false)
  const [sessionPrice, setSessionPrice] = useState("")
  const [minSessions, setMinSessions] = useState("")
  const [maxSessions, setMaxSessions] = useState("")
  const [savingSessionSettings, setSavingSessionSettings] = useState(false)

  // Activate modal
  const [showActivate, setShowActivate] = useState(false)
  const [activateTarget, setActivateTarget] = useState<ShopCode | null>(null)
  const [activateAmount, setActivateAmount] = useState("")
  const [activateMethod, setActivateMethod] = useState<"wallet" | "momo">("wallet")
  const [activateTokens, setActivateTokens] = useState("0")
  const [activating, setActivating] = useState(false)

  useEffect(() => {
    checkAdminAndLoad()
  }, [])

  const checkAdminAndLoad = async () => {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) { router.push("/dashboard"); return }
    let isAdmin = user.user_metadata?.role === "admin"
    if (!isAdmin) {
      const { data } = await supabase.from("users").select("role").eq("id", user.id).single()
      isAdmin = data?.role === "admin"
    }
    if (!isAdmin) { toast.error("Unauthorized"); router.push("/dashboard"); return }
    await loadAll()
  }

  const authHeader = async (): Promise<Record<string, string>> => {
    const { data: { session } } = await supabase.auth.getSession()
    return session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}
  }

  const loadAll = async () => {
    setLoading(true)
    try {
      const [codesRes, shopsRes, settingsRes] = await Promise.all([
        fetch("/api/admin/ussd-shops", { headers: await authHeader() }),
        supabase.from("user_shops").select("id, shop_name").eq("is_active", true).order("shop_name"),
        fetch("/api/admin/settings", { headers: await authHeader() }),
      ])
      if (codesRes.ok) {
        const { data } = await codesRes.json()
        setCodes(data ?? [])
      }
      setUserShops(shopsRes.data ?? [])
      if (settingsRes.ok) {
        const settingsJson = await settingsRes.json()
        setDialCode(settingsJson.ussd_shop_dial_code ?? "")
        setSessionPrice(String(settingsJson.ussd_shop_session_price ?? ""))
        setMinSessions(String(settingsJson.ussd_shop_min_sessions ?? "1"))
        setMaxSessions(String(settingsJson.ussd_shop_max_sessions ?? "100"))
      }

      // Load recent orders
      const { data: ordersData } = await supabase
        .from("ussd_shop_orders")
        .select("id, shop_code_id, dialing_phone, recipient_phone, network, package_size, amount, order_status, payment_status, created_at")
        .order("created_at", { ascending: false })
        .limit(100)
      setOrders(ordersData ?? [])
    } catch (e) {
      toast.error("Failed to load data")
    } finally {
      setLoading(false)
    }
  }

  const handleSaveDialCode = async () => {
    setSavingDialCode(true)
    try {
      const res = await fetch("/api/admin/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...await authHeader() },
        body: JSON.stringify({ ussd_shop_dial_code: dialCode.trim() }),
      })
      if (!res.ok) throw new Error()
      toast.success("USSD dial code saved")
    } catch {
      toast.error("Failed to save dial code")
    } finally {
      setSavingDialCode(false)
    }
  }

  const handleSaveSessionSettings = async () => {
    setSavingSessionSettings(true)
    try {
      const res = await fetch("/api/admin/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...await authHeader() },
        body: JSON.stringify({
          ussd_shop_session_price: parseFloat(sessionPrice) || 0,
          ussd_shop_min_sessions: parseInt(minSessions) || 1,
          ussd_shop_max_sessions: parseInt(maxSessions) || 100,
        }),
      })
      if (!res.ok) throw new Error()
      toast.success("Session settings saved")
    } catch {
      toast.error("Failed to save session settings")
    } finally {
      setSavingSessionSettings(false)
    }
  }

  const handleCreate = async () => {
    if (!createShopId) { toast.error("Select a shop"); return }
    setCreating(true)
    try {
      const res = await fetch("/api/admin/ussd-shops", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...await authHeader() },
        body: JSON.stringify({
          shop_id: createShopId,
          code: createCode.trim() || undefined,
          initial_tokens: parseInt(createTokens) || 0,
        }),
      })
      const json = await res.json()
      if (!res.ok) { toast.error(json.error ?? "Failed"); return }
      toast.success(`Shop code ${json.data.code} created`)
      setShowCreate(false)
      setCreateShopId(""); setCreateCode(""); setCreateTokens("0")
      await loadAll()
    } finally { setCreating(false) }
  }

  const handleStatusToggle = async (code: ShopCode) => {
    const newStatus = code.status === 'active' ? 'suspended' : 'active'
    const res = await fetch(`/api/admin/ussd-shops/${code.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...await authHeader() },
      body: JSON.stringify({ status: newStatus }),
    })
    if (res.ok) {
      toast.success(`Code ${code.code} ${newStatus}`)
      await loadAll()
    } else {
      toast.error("Failed to update status")
    }
  }

  const handleDelete = async (code: ShopCode) => {
    if (!confirm(`Delete code ${code.code}? This cannot be undone.`)) return
    const res = await fetch(`/api/admin/ussd-shops/${code.id}`, {
      method: "DELETE",
      headers: await authHeader(),
    })
    const json = await res.json()
    if (!res.ok) { toast.error(json.error ?? "Failed to delete"); return }
    toast.success("Deleted")
    await loadAll()
  }

  const handleAddTokens = async () => {
    if (!tokensTarget) return
    setAddingTokens(true)
    try {
      const res = await fetch(`/api/admin/ussd-shops/${tokensTarget.id}/tokens`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...await authHeader() },
        body: JSON.stringify({
          tokens: parseInt(tokenQty),
          amount: parseFloat(tokenAmount),
          payment_method: tokenMethod,
        }),
      })
      const json = await res.json()
      if (!res.ok) { toast.error(json.error ?? "Failed"); return }
      if (tokenMethod === 'wallet') {
        toast.success(`${tokenQty} tokens added. New balance: ${json.new_token_balance}`)
      } else {
        toast.success("MoMo prompt sent. Tokens will be added on payment.")
      }
      setShowTokens(false)
      await loadAll()
    } finally { setAddingTokens(false) }
  }

  const handleActivate = async () => {
    if (!activateTarget) return
    setActivating(true)
    try {
      const res = await fetch(`/api/admin/ussd-shops/${activateTarget.id}/activate`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...await authHeader() },
        body: JSON.stringify({
          payment_method: activateMethod,
          amount: parseFloat(activateAmount),
          initial_tokens: parseInt(activateTokens) || 0,
        }),
      })
      const json = await res.json()
      if (!res.ok) { toast.error(json.error ?? "Failed"); return }
      if (activateMethod === 'wallet') {
        toast.success(`Code ${activateTarget.code} activated!`)
      } else {
        toast.success("MoMo prompt sent to shop owner. Code will activate on payment.")
      }
      setShowActivate(false)
      await loadAll()
    } finally { setActivating(false) }
  }

  const statusBadge = (status: string) => {
    if (status === 'active') return <Badge className="bg-green-100 text-green-800 border-green-200">Active</Badge>
    if (status === 'suspended') return <Badge className="bg-yellow-100 text-yellow-800 border-yellow-200">Suspended</Badge>
    return <Badge className="bg-gray-100 text-gray-600 border-gray-200">Inactive</Badge>
  }

  const paymentBadge = (status: string) => {
    if (status === 'completed') return <Badge className="bg-green-100 text-green-800 text-xs">Paid</Badge>
    if (status === 'failed') return <Badge className="bg-red-100 text-red-800 text-xs">Failed</Badge>
    if (status === 'otp_required') return <Badge className="bg-yellow-100 text-yellow-800 text-xs">OTP</Badge>
    return <Badge className="bg-gray-100 text-gray-600 text-xs">Pending</Badge>
  }

  const filtered = codes.filter(c =>
    c.code.includes(searchQuery) ||
    c.shop_name?.toLowerCase().includes(searchQuery.toLowerCase())
  )

  if (loading) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center h-64 text-gray-500">Loading USSD shops...</div>
      </DashboardLayout>
    )
  }

  return (
    <DashboardLayout>
      <div className="p-6 max-w-7xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">USSD Shops</h1>
            <p className="text-sm text-gray-500 mt-1">Manage shop codes, tokens, and orders for the shop-code USSD storefront</p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={loadAll}>
              <RefreshCw className="w-4 h-4 mr-1" /> Refresh
            </Button>
            <Button size="sm" onClick={() => setShowCreate(true)}>
              <Plus className="w-4 h-4 mr-1" /> New Shop Code
            </Button>
          </div>
        </div>

        {/* USSD Settings */}
        <Card className="mb-6 border-blue-200 bg-blue-50">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold text-blue-800 flex items-center gap-2">
              <Settings2 className="w-4 h-4" />
              USSD Storefront Settings
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">

            {/* Dial Code */}
            <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-end">
              <div className="flex-1 space-y-1">
                <Label className="text-xs text-blue-700">Dial Code (shown to shop owners)</Label>
                <Input
                  placeholder="e.g. *713# or *920*1#"
                  value={dialCode}
                  onChange={e => setDialCode(e.target.value)}
                  className="bg-white border-blue-200 font-mono"
                />
                <p className="text-xs text-blue-600">Customers dial this code to access any shop's storefront.</p>
              </div>
              <Button
                size="sm"
                onClick={handleSaveDialCode}
                disabled={savingDialCode}
                className="bg-blue-600 hover:bg-blue-700 shrink-0"
              >
                <Save className="w-3 h-3 mr-1" />
                {savingDialCode ? "Saving..." : "Save"}
              </Button>
            </div>

            <div className="border-t border-blue-200" />

            {/* Session Settings */}
            <div className="space-y-3">
              <p className="text-xs font-semibold text-blue-800 uppercase tracking-wide">Session Purchase Settings</p>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="space-y-1">
                  <Label className="text-xs text-blue-700">Price per Session (GHS)</Label>
                  <Input
                    type="number"
                    min="0"
                    step="0.01"
                    placeholder="e.g. 0.50"
                    value={sessionPrice}
                    onChange={e => setSessionPrice(e.target.value)}
                    className="bg-white border-blue-200"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs text-blue-700">Minimum Purchase</Label>
                  <Input
                    type="number"
                    min="1"
                    placeholder="e.g. 10"
                    value={minSessions}
                    onChange={e => setMinSessions(e.target.value)}
                    className="bg-white border-blue-200"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs text-blue-700">Maximum Purchase</Label>
                  <Input
                    type="number"
                    min="1"
                    placeholder="e.g. 500"
                    value={maxSessions}
                    onChange={e => setMaxSessions(e.target.value)}
                    className="bg-white border-blue-200"
                  />
                </div>
              </div>
              {sessionPrice && minSessions && maxSessions && (
                <p className="text-xs text-blue-600">
                  Shop owners can buy between {minSessions}–{maxSessions} sessions at GHS {parseFloat(sessionPrice || "0").toFixed(2)} each.
                </p>
              )}
              <Button
                size="sm"
                onClick={handleSaveSessionSettings}
                disabled={savingSessionSettings}
                className="bg-blue-600 hover:bg-blue-700"
              >
                <Save className="w-3 h-3 mr-1" />
                {savingSessionSettings ? "Saving..." : "Save Session Settings"}
              </Button>
            </div>

          </CardContent>
        </Card>

        <Tabs defaultValue="codes">
          <TabsList className="mb-4">
            <TabsTrigger value="codes">Shop Codes ({codes.length})</TabsTrigger>
            <TabsTrigger value="orders">Orders ({orders.length})</TabsTrigger>
          </TabsList>

          <TabsContent value="codes">
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base font-medium">All Shop Codes</CardTitle>
                  <Input
                    placeholder="Search code or shop name..."
                    value={searchQuery}
                    onChange={e => setSearchQuery(e.target.value)}
                    className="w-60 h-8 text-sm"
                  />
                </div>
              </CardHeader>
              <CardContent>
                {filtered.length === 0 ? (
                  <div className="text-center py-12 text-gray-400">
                    <Hash className="w-10 h-10 mx-auto mb-3 opacity-40" />
                    <p>No shop codes yet. Click "New Shop Code" to create one.</p>
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b text-left text-gray-500 text-xs uppercase tracking-wide">
                          <th className="pb-3 pr-4">Code</th>
                          <th className="pb-3 pr-4">Shop</th>
                          <th className="pb-3 pr-4">Status</th>
                          <th className="pb-3 pr-4">Tokens</th>
                          <th className="pb-3 pr-4">Orders</th>
                          <th className="pb-3">Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filtered.map(code => (
                          <tr key={code.id} className="border-b last:border-0 hover:bg-gray-50">
                            <td className="py-3 pr-4">
                              <code className="bg-gray-100 text-gray-800 font-mono font-bold text-base px-2 py-1 rounded">
                                {code.code}
                              </code>
                            </td>
                            <td className="py-3 pr-4">
                              <span className="font-medium text-gray-800">{code.shop_name}</span>
                            </td>
                            <td className="py-3 pr-4">{statusBadge(code.status)}</td>
                            <td className="py-3 pr-4">
                              <span className={`font-bold ${code.token_balance <= 5 ? 'text-red-600' : 'text-gray-800'}`}>
                                {code.token_balance}
                              </span>
                              {code.token_balance <= 5 && code.token_balance > 0 && (
                                <span className="text-xs text-red-500 ml-1">low</span>
                              )}
                            </td>
                            <td className="py-3 pr-4 text-gray-600">{code.order_count}</td>
                            <td className="py-3">
                              <div className="flex gap-1 flex-wrap">
                                {!code.activation_fee_paid && (
                                  <Button
                                    size="sm" variant="outline"
                                    className="h-7 text-xs border-green-300 text-green-700 hover:bg-green-50"
                                    onClick={() => { setActivateTarget(code); setShowActivate(true) }}
                                  >
                                    <CheckCircle className="w-3 h-3 mr-1" /> Activate
                                  </Button>
                                )}
                                <Button
                                  size="sm" variant="outline"
                                  className="h-7 text-xs"
                                  onClick={() => { setTokensTarget(code); setTokenQty("10"); setTokenAmount(""); setShowTokens(true) }}
                                >
                                  <Coins className="w-3 h-3 mr-1" /> Tokens
                                </Button>
                                {code.activation_fee_paid && (
                                  <Button
                                    size="sm" variant="outline"
                                    className={`h-7 text-xs ${code.status === 'active' ? 'border-yellow-300 text-yellow-700 hover:bg-yellow-50' : 'border-green-300 text-green-700 hover:bg-green-50'}`}
                                    onClick={() => handleStatusToggle(code)}
                                  >
                                    <PauseCircle className="w-3 h-3 mr-1" />
                                    {code.status === 'active' ? 'Suspend' : 'Activate'}
                                  </Button>
                                )}
                                <Button
                                  size="sm" variant="outline"
                                  className="h-7 text-xs border-red-200 text-red-600 hover:bg-red-50"
                                  onClick={() => handleDelete(code)}
                                >
                                  <Trash2 className="w-3 h-3" />
                                </Button>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="orders">
            <Card>
              <CardHeader>
                <CardTitle className="text-base font-medium">Recent Orders</CardTitle>
              </CardHeader>
              <CardContent>
                {orders.length === 0 ? (
                  <div className="text-center py-12 text-gray-400">No orders yet.</div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b text-left text-gray-500 text-xs uppercase tracking-wide">
                          <th className="pb-3 pr-4">Order ID</th>
                          <th className="pb-3 pr-4">From</th>
                          <th className="pb-3 pr-4">To</th>
                          <th className="pb-3 pr-4">Bundle</th>
                          <th className="pb-3 pr-4">Amount</th>
                          <th className="pb-3 pr-4">Payment</th>
                          <th className="pb-3">Date</th>
                        </tr>
                      </thead>
                      <tbody>
                        {orders.map(order => (
                          <tr key={order.id} className="border-b last:border-0 hover:bg-gray-50">
                            <td className="py-3 pr-4">
                              <code className="text-xs text-gray-500">{order.id.slice(0, 8)}</code>
                            </td>
                            <td className="py-3 pr-4 text-gray-700">{order.dialing_phone}</td>
                            <td className="py-3 pr-4 text-gray-700">{order.recipient_phone}</td>
                            <td className="py-3 pr-4">
                              <span className="font-medium">{order.package_size}</span>
                              <span className="text-gray-400 ml-1 text-xs">{order.network}</span>
                            </td>
                            <td className="py-3 pr-4 font-medium">GHS {Number(order.amount).toFixed(2)}</td>
                            <td className="py-3 pr-4">{paymentBadge(order.payment_status)}</td>
                            <td className="py-3 text-gray-400 text-xs">
                              {new Date(order.created_at).toLocaleDateString()}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>

      {/* Create Shop Code Modal */}
      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Create Shop Code</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 mt-2">
            <div className="space-y-1">
              <Label>Shop</Label>
              <Select value={createShopId} onValueChange={setCreateShopId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a shop..." />
                </SelectTrigger>
                <SelectContent>
                  {userShops.map(s => (
                    <SelectItem key={s.id} value={s.id}>{s.shop_name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Shop Code (4-digit PIN)</Label>
              <Input
                placeholder="Leave blank to auto-generate"
                value={createCode}
                onChange={e => setCreateCode(e.target.value.replace(/\D/g, '').slice(0, 8))}
                maxLength={8}
              />
              <p className="text-xs text-gray-400">Leave blank to auto-generate a unique 4-digit code</p>
            </div>
            <div className="space-y-1">
              <Label>Initial Tokens</Label>
              <Input
                type="number" min="0" value={createTokens}
                onChange={e => setCreateTokens(e.target.value)}
              />
              <p className="text-xs text-gray-400">Each token = one customer session. Can add more later.</p>
            </div>
            <div className="flex gap-2 pt-2">
              <Button variant="outline" onClick={() => setShowCreate(false)} className="flex-1">Cancel</Button>
              <Button onClick={handleCreate} disabled={creating} className="flex-1">
                {creating ? "Creating..." : "Create"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Add Tokens Modal */}
      <Dialog open={showTokens} onOpenChange={setShowTokens}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Add Tokens — {tokensTarget?.shop_name} ({tokensTarget?.code})</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 mt-2">
            <p className="text-sm text-gray-500">
              Current balance: <strong>{tokensTarget?.token_balance ?? 0}</strong> tokens
            </p>
            <div className="space-y-1">
              <Label>Tokens to Add</Label>
              <Input type="number" min="1" value={tokenQty} onChange={e => setTokenQty(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>Amount Paid (GHS)</Label>
              <Input
                type="number" min="0" step="0.01" placeholder="e.g. 50.00"
                value={tokenAmount} onChange={e => setTokenAmount(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label>Payment Method</Label>
              <div className="flex gap-2">
                {(['wallet', 'momo'] as const).map(m => (
                  <button key={m} onClick={() => setTokenMethod(m)}
                    className={`flex-1 py-2 px-3 rounded-lg border-2 text-sm font-medium transition-colors capitalize ${
                      tokenMethod === m ? 'border-blue-600 bg-blue-600 text-white' : 'border-gray-200 bg-white text-gray-700 hover:border-blue-300'
                    }`}>
                    {m === 'wallet' ? 'Wallet Deduction' : 'MoMo Charge'}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex gap-2 pt-2">
              <Button variant="outline" onClick={() => setShowTokens(false)} className="flex-1">Cancel</Button>
              <Button onClick={handleAddTokens} disabled={addingTokens || !tokenAmount} className="flex-1">
                {addingTokens ? "Processing..." : "Add Tokens"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Activate Modal */}
      <Dialog open={showActivate} onOpenChange={setShowActivate}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Activate — {activateTarget?.shop_name} ({activateTarget?.code})</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 mt-2">
            <p className="text-sm text-gray-500">
              Record the one-time activation payment from the shop owner and set the code to Active.
            </p>
            <div className="space-y-1">
              <Label>Activation Fee Paid (GHS)</Label>
              <Input
                type="number" min="0" step="0.01" placeholder="e.g. 100.00"
                value={activateAmount} onChange={e => setActivateAmount(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label>Initial Tokens</Label>
              <Input type="number" min="0" value={activateTokens} onChange={e => setActivateTokens(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>Payment Method</Label>
              <div className="flex gap-2">
                {(['wallet', 'momo'] as const).map(m => (
                  <button key={m} onClick={() => setActivateMethod(m)}
                    className={`flex-1 py-2 px-3 rounded-lg border-2 text-sm font-medium transition-colors capitalize ${
                      activateMethod === m ? 'border-green-600 bg-green-600 text-white' : 'border-gray-200 bg-white text-gray-700 hover:border-green-300'
                    }`}>
                    {m === 'wallet' ? 'Wallet Deduction' : 'MoMo Charge'}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex gap-2 pt-2">
              <Button variant="outline" onClick={() => setShowActivate(false)} className="flex-1">Cancel</Button>
              <Button onClick={handleActivate} disabled={activating || !activateAmount}
                className="flex-1 bg-green-600 hover:bg-green-700">
                {activating ? "Activating..." : "Activate Shop"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  )
}
