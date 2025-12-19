"use client"

import { useEffect, useState } from "react"
import { useAuth } from "@/lib/auth-context"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { shopService, shopOrderService, shopProfitService, withdrawalService } from "@/lib/shop-service"
import { TrendingUp, DollarSign, ShoppingCart, CreditCard, AlertCircle, Copy } from "lucide-react"
import { toast } from "sonner"

export default function ShopDashboardPage() {
  const { user } = useAuth()
  const [shop, setShop] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [profits, setProfits] = useState<any[]>([])
  const [balance, setBalance] = useState(0)
  const [totalProfit, setTotalProfit] = useState(0)
  const [withdrawals, setWithdrawals] = useState<any[]>([])
  const [orders, setOrders] = useState<any[]>([])
  const [customerStats, setCustomerStats] = useState<any>(null)
  const [withdrawalForm, setWithdrawalForm] = useState({
    amount: "",
    method: "mobile_money",
    phone: "",
    accountName: "",
    bankName: "",
    accountNumber: "",
    network: "MTN",
  })
  const [showWithdrawalForm, setShowWithdrawalForm] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [withdrawalFeePercentage, setWithdrawalFeePercentage] = useState(0)

  useEffect(() => {
    if (!user) return
    loadDashboardData()
    fetchWithdrawalFee()
  }, [user])

  const fetchWithdrawalFee = async () => {
    try {
      const response = await fetch("/api/settings/fees")
      const data = await response.json()
      if (data.withdrawal_fee_percentage !== undefined) {
        setWithdrawalFeePercentage(data.withdrawal_fee_percentage)
      }
    } catch (error) {
      console.warn("Failed to fetch withdrawal fee:", error)
      // Continue with default fee of 0
    }
  }

  const loadDashboardData = async () => {
    try {
      setLoading(true)
      if (!user?.id) return
      const userShop = await shopService.getShop(user.id)
      
      if (!userShop) {
        toast.error("Shop not found")
        return
      }

      setShop(userShop)

      // Load all data in parallel with error handling
      const [
        balanceData,
        totalProfit,
        profitHistory,
        withdrawalList,
        orderList,
        stats
      ] = await Promise.all([
        shopProfitService.getShopBalanceFromTable(userShop.id).catch(() => null),
        shopProfitService.getTotalProfit(userShop.id).catch(() => 0),
        shopProfitService.getProfitHistory(userShop.id).catch(() => []),
        withdrawalService.getWithdrawalRequests(user.id).catch(() => []),
        shopOrderService.getShopOrders(userShop.id).catch(() => []),
        fetchCustomerStats(userShop.id).catch(() => null),
      ])

      // Use balance from table (should always exist now)
      const finalBalance = balanceData?.available_balance || 0
      
      setBalance(finalBalance)
      setTotalProfit(totalProfit || 0)
      setProfits(profitHistory || [])
      setWithdrawals(withdrawalList || [])
      setOrders(orderList || [])
      setCustomerStats(stats)
    } catch (error) {
      console.error("Error loading dashboard:", error)
      const errorMessage = error instanceof Error ? error.message : "Failed to load shop dashboard"
      toast.error(errorMessage)
    } finally {
      setLoading(false)
    }
  }

  const fetchCustomerStats = async (shopId: string) => {
    try {
      const { customerTrackingService } = await import('@/lib/customer-tracking-service')
      const stats = await customerTrackingService.getCustomerStats(shopId)
      return stats
    } catch (error) {
      console.warn("Failed to fetch customer stats:", error)
      return null
    }
  }

  const handleWithdrawal = async () => {
    const amount = parseFloat(withdrawalForm.amount)

    if (!amount || amount <= 0) {
      toast.error("Please enter a valid amount")
      return
    }

    if (amount < 5) {
      toast.error("Minimum withdrawal amount is GHS 5.00")
      return
    }

    if (amount > balance) {
      toast.error("Insufficient balance")
      return
    }

    if (!withdrawalForm.accountName.trim()) {
      toast.error("Please enter the account name")
      return
    }

    if (withdrawalForm.method === "mobile_money" && !withdrawalForm.phone) {
      toast.error("Please enter your phone number")
      return
    }

    if (withdrawalForm.method === "bank_transfer") {
      if (!withdrawalForm.bankName.trim()) {
        toast.error("Please enter the bank name")
        return
      }
      if (!withdrawalForm.accountNumber.trim()) {
        toast.error("Please enter the account number")
        return
      }
    }

    if (!user?.id || !shop?.id) {
      toast.error("Missing user or shop information")
      return
    }

    setIsSubmitting(true)
    try {
      const accountDetails: any = {}
      if (withdrawalForm.method === "mobile_money") {
        accountDetails.phone = withdrawalForm.phone
        accountDetails.account_name = withdrawalForm.accountName
        accountDetails.network = withdrawalForm.network
      } else if (withdrawalForm.method === "bank_transfer") {
        accountDetails.bank_name = withdrawalForm.bankName
        accountDetails.account_number = withdrawalForm.accountNumber
        accountDetails.account_name = withdrawalForm.accountName
      }

      await withdrawalService.createWithdrawalRequest(
        user.id,
        shop.id,
        {
          amount,
          withdrawal_method: withdrawalForm.method,
          account_details: accountDetails,
        }
      )

      toast.success("Withdrawal request submitted successfully")
      setWithdrawalForm({ amount: "", method: "mobile_money", phone: "", accountName: "", bankName: "", accountNumber: "", network: "MTN" })
      setShowWithdrawalForm(false)

      // Reload withdrawals
      const updated = await withdrawalService.getWithdrawalRequests(user.id)
      setWithdrawals(updated || [])
    } catch (error) {
      console.error("Error creating withdrawal:", error)
      const errorMessage = error instanceof Error ? error.message : "Failed to create withdrawal request"
      toast.error(errorMessage)
    } finally {
      setIsSubmitting(false)
    }
  }

  if (loading) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center min-h-screen">
          <p className="text-gray-500">Loading dashboard...</p>
        </div>
      </DashboardLayout>
    )
  }

  if (!shop) {
    return (
      <DashboardLayout>
        <div className="space-y-6">
          <Alert className="border-red-300 bg-red-50">
            <AlertCircle className="h-4 w-4 text-red-600" />
            <AlertDescription className="text-red-700">
              Shop not found. Please create a shop first.
            </AlertDescription>
          </Alert>
        </div>
      </DashboardLayout>
    )
  }

  const pendingWithdrawals = withdrawals.filter(w => w.status === "pending")
  const completedWithdrawals = withdrawals.filter(w => w.status === "completed")

  return (
    <DashboardLayout>
      <div className="space-y-6">
        {/* Header */}
        <div>
          <h1 className="text-4xl font-bold bg-gradient-to-r from-violet-600 via-purple-600 to-fuchsia-600 bg-clip-text text-transparent">Shop Dashboard</h1>
          <p className="text-gray-500 mt-1">Track your profits and manage withdrawals</p>
        </div>

        {/* Stats Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2 sm:gap-3 lg:gap-4">
          {/* Available Balance */}
          <Card className="hover:shadow-2xl transition-all duration-300 hover:-translate-y-1 border-l-4 border-l-cyan-500 bg-gradient-to-br from-cyan-50/60 to-blue-50/40 backdrop-blur-xl border border-cyan-200/40">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Available Balance</CardTitle>
              <div className="bg-gradient-to-br from-cyan-400/30 to-blue-400/20 backdrop-blur p-2 rounded-lg border border-cyan-300/60">
                <DollarSign className="h-4 w-4 text-cyan-600" />
              </div>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold bg-gradient-to-r from-cyan-600 to-blue-600 bg-clip-text text-transparent">
                GHS {balance.toFixed(2)}
              </div>
              <p className="text-xs text-gray-500">Ready to withdraw</p>
            </CardContent>
          </Card>

          {/* Total Profit */}
          <Card className="hover:shadow-2xl transition-all duration-300 hover:-translate-y-1 border-l-4 border-l-emerald-500 bg-gradient-to-br from-emerald-50/60 to-teal-50/40 backdrop-blur-xl border border-emerald-200/40">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Profit</CardTitle>
              <div className="bg-gradient-to-br from-emerald-400/30 to-teal-400/20 backdrop-blur p-2 rounded-lg border border-emerald-300/60">
                <TrendingUp className="h-4 w-4 text-emerald-600" />
              </div>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold bg-gradient-to-r from-emerald-600 to-teal-600 bg-clip-text text-transparent">
                GHS {totalProfit.toFixed(2)}
              </div>
              <p className="text-xs text-gray-500">All time profit</p>
            </CardContent>
          </Card>

          {/* Total Orders */}
          <Card className="hover:shadow-2xl transition-all duration-300 hover:-translate-y-1 border-l-4 border-l-amber-500 bg-gradient-to-br from-amber-50/60 to-orange-50/40 backdrop-blur-xl border border-amber-200/40">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Orders</CardTitle>
              <div className="bg-gradient-to-br from-amber-400/30 to-orange-400/20 backdrop-blur p-2 rounded-lg border border-amber-300/60">
                <ShoppingCart className="h-4 w-4 text-amber-600" />
              </div>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold bg-gradient-to-r from-amber-600 to-orange-600 bg-clip-text text-transparent">
                {orders.length}
              </div>
              <p className="text-xs text-gray-500">All orders</p>
            </CardContent>
          </Card>

          {/* Pending Withdrawals */}
          <Card className="hover:shadow-2xl transition-all duration-300 hover:-translate-y-1 border-l-4 border-l-rose-500 bg-gradient-to-br from-rose-50/60 to-pink-50/40 backdrop-blur-xl border border-rose-200/40">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Pending Withdrawals</CardTitle>
              <div className="bg-gradient-to-br from-rose-400/30 to-pink-400/20 backdrop-blur p-2 rounded-lg border border-rose-300/60">
                <CreditCard className="h-4 w-4 text-rose-600" />
              </div>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold bg-gradient-to-r from-rose-600 to-pink-600 bg-clip-text text-transparent">
                {pendingWithdrawals.length}
              </div>
              <p className="text-xs text-gray-500">Awaiting approval</p>
            </CardContent>
          </Card>
        </div>

        {/* Customer Stats Section */}
        {customerStats && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-2 sm:gap-3 lg:gap-4 pt-2">
            {/* Total Customers */}
            <Card className="hover:shadow-2xl transition-all duration-300 hover:-translate-y-1 border-l-4 border-l-indigo-500 bg-gradient-to-br from-indigo-50/60 to-purple-50/40 backdrop-blur-xl border border-indigo-200/40">
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Total Customers</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold bg-gradient-to-r from-indigo-600 to-purple-600 bg-clip-text text-transparent">
                  {customerStats.total_customers}
                </div>
                <p className="text-xs text-gray-500">Unique customers</p>
              </CardContent>
            </Card>

            {/* Repeat Customers */}
            <Card className="hover:shadow-2xl transition-all duration-300 hover:-translate-y-1 border-l-4 border-l-pink-500 bg-gradient-to-br from-pink-50/60 to-rose-50/40 backdrop-blur-xl border border-pink-200/40">
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Repeat Customers</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold bg-gradient-to-r from-pink-600 to-rose-600 bg-clip-text text-transparent">
                  {customerStats.repeat_customers}
                </div>
                <p className="text-xs text-gray-500">
                  {customerStats.total_customers > 0 
                    ? `${customerStats.repeat_percentage.toFixed(1)}% of customers`
                    : "No customers yet"}
                </p>
              </CardContent>
            </Card>

            {/* New This Month */}
            <Card className="hover:shadow-2xl transition-all duration-300 hover:-translate-y-1 border-l-4 border-l-green-500 bg-gradient-to-br from-green-50/60 to-emerald-50/40 backdrop-blur-xl border border-green-200/40">
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">New This Month</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold bg-gradient-to-r from-green-600 to-emerald-600 bg-clip-text text-transparent">
                  {customerStats.new_customers_month}
                </div>
                <p className="text-xs text-gray-500">Recent acquisitions</p>
              </CardContent>
            </Card>

            {/* Average LTV */}
            <Card className="hover:shadow-2xl transition-all duration-300 hover:-translate-y-1 border-l-4 border-l-blue-500 bg-gradient-to-br from-blue-50/60 to-cyan-50/40 backdrop-blur-xl border border-blue-200/40">
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Avg. LTV</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold bg-gradient-to-r from-blue-600 to-cyan-600 bg-clip-text text-transparent">
                  GHS {customerStats.average_ltv.toFixed(2)}
                </div>
                <p className="text-xs text-gray-500">Per customer</p>
              </CardContent>
            </Card>

            {/* Customer Revenue */}
            <Card className="hover:shadow-2xl transition-all duration-300 hover:-translate-y-1 border-l-4 border-l-orange-500 bg-gradient-to-br from-orange-50/60 to-amber-50/40 backdrop-blur-xl border border-orange-200/40">
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Customer Revenue</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold bg-gradient-to-r from-orange-600 to-amber-600 bg-clip-text text-transparent">
                  GHS {customerStats.total_revenue.toFixed(2)}
                </div>
                <p className="text-xs text-gray-500">Total from customers</p>
              </CardContent>
            </Card>
          </div>
        )}

        {/* Withdraw Button */}
        {balance > 0 && !showWithdrawalForm && (
          <Button
            onClick={() => setShowWithdrawalForm(true)}
            className="w-full bg-gradient-to-r from-violet-600 to-purple-600 hover:from-violet-700 hover:to-purple-700"
          >
            Request Withdrawal
          </Button>
        )}

        {/* Withdrawal Form */}
        {showWithdrawalForm && (
          <Card className="bg-gradient-to-br from-violet-50/60 to-purple-50/40 backdrop-blur-xl border border-violet-200/40">
            <CardHeader>
              <CardTitle>Request Withdrawal</CardTitle>
              <CardDescription>Withdraw your available profits</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <Label>Amount (GHS) *</Label>
                <Input
                  type="number"
                  step="0.01"
                  value={withdrawalForm.amount}
                  onChange={(e) => setWithdrawalForm({ ...withdrawalForm, amount: e.target.value })}
                  placeholder="0.00"
                  min="5"
                  max={balance}
                  className="mt-1"
                />
                <p className="text-xs text-gray-600 mt-1">
                  Available: GHS {balance.toFixed(2)} | Minimum: GHS 5.00
                </p>
              </div>

              <div>
                <Label>Account Name (Full Name) *</Label>
                <Input
                  value={withdrawalForm.accountName}
                  onChange={(e) => setWithdrawalForm({ ...withdrawalForm, accountName: e.target.value })}
                  placeholder="John Doe"
                  className="mt-1"
                />
              </div>

              <div>
                <Label>Withdrawal Method *</Label>
                <select
                  value={withdrawalForm.method}
                  onChange={(e) => setWithdrawalForm({ ...withdrawalForm, method: e.target.value })}
                  className="w-full mt-1 px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-violet-500"
                >
                  <option value="mobile_money">Mobile Money</option>
                  <option value="bank_transfer">Bank Transfer</option>
                </select>
              </div>

              {withdrawalForm.method === "mobile_money" && (
                <>
                  <div>
                    <Label>Mobile Number *</Label>
                    <Input
                      value={withdrawalForm.phone}
                      onChange={(e) => setWithdrawalForm({ ...withdrawalForm, phone: e.target.value })}
                      placeholder="0201234567"
                      className="mt-1"
                    />
                  </div>
                  <div>
                    <Label>Network *</Label>
                    <select
                      value={withdrawalForm.network}
                      onChange={(e) => setWithdrawalForm({ ...withdrawalForm, network: e.target.value })}
                      className="w-full mt-1 px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-violet-500"
                    >
                      <option value="MTN">MTN</option>
                      <option value="TELECEL">TELECEL</option>
                    </select>
                  </div>
                </>
              )}

              {withdrawalForm.method === "bank_transfer" && (
                <>
                  <div>
                    <Label>Bank Name *</Label>
                    <Input
                      value={withdrawalForm.bankName}
                      onChange={(e) => setWithdrawalForm({ ...withdrawalForm, bankName: e.target.value })}
                      placeholder="e.g., GCB, Zenith Bank"
                      className="mt-1"
                    />
                  </div>
                  <div>
                    <Label>Account Number *</Label>
                    <Input
                      value={withdrawalForm.accountNumber}
                      onChange={(e) => setWithdrawalForm({ ...withdrawalForm, accountNumber: e.target.value })}
                      placeholder="1234567890"
                      className="mt-1"
                    />
                  </div>
                </>
              )}

              {withdrawalForm.amount && parseFloat(withdrawalForm.amount) > 0 && (
                <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 space-y-2">
                  <h4 className="font-semibold text-sm text-amber-900">Withdrawal Breakdown</h4>
                  <div className="text-sm space-y-1">
                    <div className="flex justify-between">
                      <span className="text-amber-700">Requested amount:</span>
                      <span className="font-medium text-amber-900">GHS {parseFloat(withdrawalForm.amount).toFixed(2)}</span>
                    </div>
                    {withdrawalFeePercentage > 0 && (
                      <>
                        <div className="flex justify-between">
                          <span className="text-amber-700">Withdrawal fee ({withdrawalFeePercentage}%):</span>
                          <span className="font-medium text-orange-600">-GHS {(parseFloat(withdrawalForm.amount) * withdrawalFeePercentage / 100).toFixed(2)}</span>
                        </div>
                        <div className="border-t border-amber-200 pt-1 flex justify-between">
                          <span className="text-amber-900 font-semibold">You will receive:</span>
                          <span className="font-bold text-green-600">GHS {(parseFloat(withdrawalForm.amount) - (parseFloat(withdrawalForm.amount) * withdrawalFeePercentage / 100)).toFixed(2)}</span>
                        </div>
                      </>
                    )}
                  </div>
                </div>
              )}

              <Alert className="border-blue-300 bg-blue-50">
                <AlertCircle className="h-4 w-4 text-blue-600" />
                <AlertDescription className="text-xs text-blue-700">
                  Withdrawal requests are processed within 1-2 business days after approval.
                </AlertDescription>
              </Alert>

              <div className="flex gap-2">
                <Button
                  onClick={handleWithdrawal}
                  disabled={isSubmitting}
                  className="flex-1 bg-violet-600 hover:bg-violet-700"
                >
                  {isSubmitting ? (
                    <>
                      <span className="animate-spin mr-2">⏳</span>
                      Submitting...
                    </>
                  ) : (
                    "Submit Request"
                  )}
                </Button>
                <Button
                  onClick={() => setShowWithdrawalForm(false)}
                  variant="outline"
                  className="flex-1"
                  disabled={isSubmitting}
                >
                  Cancel
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Tabs for Orders, Profits, and Withdrawals */}
        <Tabs defaultValue="orders" className="space-y-4">
          <TabsList className="bg-white/40 backdrop-blur border border-white/20">
            <TabsTrigger value="orders">Recent Orders ({orders.length})</TabsTrigger>
            <TabsTrigger value="profits">Profit History ({profits.length})</TabsTrigger>
            <TabsTrigger value="withdrawals">Withdrawals ({withdrawals.length})</TabsTrigger>
          </TabsList>

          {/* Orders Tab */}
          <TabsContent value="orders">
            <Card className="bg-gradient-to-br from-cyan-50/60 to-blue-50/40 backdrop-blur-xl border border-cyan-200/40">
              <CardHeader>
                <CardTitle>Recent Orders</CardTitle>
                <CardDescription>Orders from your shop customers</CardDescription>
              </CardHeader>
              <CardContent>
                {orders.length === 0 ? (
                  <p className="text-gray-600 text-center py-8">No orders yet. Share your shop link to start receiving orders!</p>
                ) : (
                  <div className="space-y-3 max-h-96 overflow-y-auto">
                    {orders.map((order) => (
                      <div
                        key={order.id}
                        className="flex items-center justify-between p-3 bg-white/50 border border-cyan-200/40 rounded-lg hover:bg-white/70"
                      >
                        <div className="flex-1">
                          <p className="font-semibold">{order.customer_name}</p>
                          <p className="text-sm text-gray-600">{order.network} - {order.volume_gb}GB</p>
                          <p className="text-xs text-gray-500">
                            {new Date(order.created_at).toLocaleDateString()} {new Date(order.created_at).toLocaleTimeString()}
                          </p>
                        </div>
                        <div className="text-right">
                          <p className="font-semibold text-cyan-600">+GHS {order.profit_amount.toFixed(2)}</p>
                          <Badge variant="outline" className={
                            order.order_status === "completed"
                              ? "bg-green-100 text-green-700"
                              : "bg-amber-100 text-amber-700"
                          }>
                            {order.order_status}
                          </Badge>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* Profit History Tab */}
          <TabsContent value="profits">
            <Card className="bg-gradient-to-br from-amber-50/60 to-yellow-50/40 backdrop-blur-xl border border-amber-200/40">
              <CardHeader>
                <CardTitle>Profit History</CardTitle>
                <CardDescription>Detailed breakdown of your profits by transaction</CardDescription>
              </CardHeader>
              <CardContent>
                {profits.length === 0 ? (
                  <p className="text-gray-600 text-center py-8">No profit history yet. Complete orders to start earning!</p>
                ) : (
                  <div className="space-y-3 max-h-96 overflow-y-auto">
                    {profits.map((profit: any) => {
                      const profitAmount = profit.profit_amount || profit.amount || 0
                      return (
                      <div
                        key={profit.id}
                        className="flex items-center justify-between p-3 bg-white/50 border border-amber-200/40 rounded-lg hover:bg-white/70"
                      >
                        <div className="flex-1">
                          <p className="font-semibold">GHS {profitAmount.toFixed(2)}</p>
                          <p className="text-sm text-gray-600">{profit.profit_type || "Order Profit"}</p>
                          <p className="text-xs text-gray-500">{new Date(profit.created_at).toLocaleDateString()}</p>
                        </div>
                        <div className="text-right">
                          <Badge className="bg-emerald-600">
                            {profit.status || "Completed"}
                          </Badge>
                        </div>
                      </div>
                    )
                    })}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* Withdrawals Tab */}
          <TabsContent value="withdrawals">
            <Card className="bg-gradient-to-br from-emerald-50/60 to-teal-50/40 backdrop-blur-xl border border-emerald-200/40">
              <CardHeader>
                <CardTitle>Withdrawal History</CardTitle>
                <CardDescription>Your withdrawal requests and status</CardDescription>
              </CardHeader>
              <CardContent>
                {withdrawals.length === 0 ? (
                  <p className="text-gray-600 text-center py-8">No withdrawals yet.</p>
                ) : (
                  <div className="space-y-3 max-h-96 overflow-y-auto">
                    {withdrawals.map((withdrawal) => (
                      <div
                        key={withdrawal.id}
                        className="flex items-center justify-between p-3 bg-white/50 border border-emerald-200/40 rounded-lg"
                      >
                        <div className="flex-1">
                          <p className="font-semibold">GHS {withdrawal.amount.toFixed(2)}</p>
                          <p className="text-sm text-gray-600">{withdrawal.withdrawal_method}</p>
                          <p className="text-xs text-gray-500">{new Date(withdrawal.created_at).toLocaleDateString()}</p>
                        </div>
                        <Badge className={
                          withdrawal.status === "completed"
                            ? "bg-green-600"
                            : withdrawal.status === "pending"
                            ? "bg-amber-600"
                            : withdrawal.status === "approved"
                            ? "bg-blue-600"
                            : "bg-red-600"
                        }>
                          {withdrawal.status}
                        </Badge>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </DashboardLayout>
  )
}
