"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
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
import { supabase } from "@/lib/supabase"
import { TrendingUp, DollarSign, ShoppingCart, CreditCard, AlertCircle, Copy, Loader2, CheckCircle, Search, Package, MessageCircle } from "lucide-react"
import { toast } from "sonner"
import { ComplaintModal } from "@/components/complaint-modal"

export default function ShopDashboardPage() {
  const { user } = useAuth()
  const [shop, setShop] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [profits, setProfits] = useState<any[]>([])
  const [balance, setBalance] = useState(0)
  const [totalProfit, setTotalProfit] = useState(0)
  const [withdrawals, setWithdrawals] = useState<any[]>([])
  const [orders, setOrders] = useState<any[]>([])
  const [customerStats, setCustomerStats] = useState<any>({
    total_customers: 0,
    repeat_customers: 0,
    repeat_percentage: 0,
    new_customers_month: 0,
    average_ltv: 0,
    total_revenue: 0,
  })
  const [withdrawalForm, setWithdrawalForm] = useState({
    amount: "",
    method: "mobile_money",
    phone: "",
    accountName: "",
    bankName: "",
    bankSublistId: "",
    accountNumber: "",
    network: "MTN",
  })
  const [showWithdrawalForm, setShowWithdrawalForm] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [isFetchingName, setIsFetchingName] = useState(false)
  const [nameVerified, setNameVerified] = useState(false)
  const [bankVerified, setBankVerified] = useState(false)
  const [isFetchingBankName, setIsFetchingBankName] = useState(false)
  const [banks, setBanks] = useState<{ name: string; sublistid: string }[]>([])
  const [loadingBanks, setLoadingBanks] = useState(false)
  const [withdrawalFeePercentage, setWithdrawalFeePercentage] = useState(0)
  const [orderStats, setOrderStats] = useState({ total: 0, completed: 0, pending: 0, failed: 0, totalRevenue: 0 })
  const [searchPhoneNumber, setSearchPhoneNumber] = useState("")
  const [selectedComplaintOrder, setSelectedComplaintOrder] = useState<any>(null)
  const [showComplaintModal, setShowComplaintModal] = useState(false)

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
    }
  }

  const fetchBanks = async () => {
    if (banks.length > 0) return // already loaded
    setLoadingBanks(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const response = await fetch("/api/user/withdrawals/banks", {
        headers: session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {},
      })
      if (response.ok) {
        const data = await response.json()
        setBanks(Array.isArray(data) ? data : [])
      }
    } catch (error) {
      console.warn("Failed to fetch bank list:", error)
    } finally {
      setLoadingBanks(false)
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
      setOrderStats({
        total: orderList?.length || 0,
        completed: orderList?.filter((o: any) => o.order_status === "completed").length || 0,
        pending: orderList?.filter((o: any) => o.order_status === "pending").length || 0,
        failed: orderList?.filter((o: any) => o.order_status === "failed").length || 0,
        totalRevenue: orderList?.reduce((sum: number, o: any) => sum + (o.profit_amount || 0), 0) || 0,
      })
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
      const { data: { session } } = await supabase.auth.getSession()
      const response = await fetch('/api/admin/customers/analytics', {
        headers: {
          'Authorization': `Bearer ${session?.access_token || user?.id}`,
        },
      })

      if (response.status === 404) {
        console.log('[DASHBOARD] User has no shop or shop has no customers yet')
        // Return default stats with zeros instead of null
        return {
          total_customers: 0,
          repeat_customers: 0,
          repeat_percentage: 0,
          new_customers_month: 0,
          average_ltv: 0,
          total_revenue: 0,
        }
      }

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}))
        console.error('Customer stats API error:', errorData)
        // Return default stats with zeros instead of null
        return {
          total_customers: 0,
          repeat_customers: 0,
          repeat_percentage: 0,
          new_customers_month: 0,
          average_ltv: 0,
          total_revenue: 0,
        }
      }

      const data = await response.json()
      console.log('[DASHBOARD] Customer stats response:', data)
      
      // Return the stats object with all fields
      return {
        total_customers: data.total_customers || 0,
        repeat_customers: data.repeat_customers || 0,
        repeat_percentage: data.repeat_percentage || 0,
        new_customers_month: data.new_customers_month || 0,
        average_ltv: data.average_ltv || 0,
        total_revenue: data.total_revenue || 0,
      }
    } catch (error) {
      console.error("[DASHBOARD] Failed to fetch customer stats:", error)
      // Return default stats with zeros instead of null
      return {
        total_customers: 0,
        repeat_customers: 0,
        repeat_percentage: 0,
        new_customers_month: 0,
        average_ltv: 0,
        total_revenue: 0,
      }
    }
  }

  const handleValidateAccount = async (phone: string, network: string) => {
    if (!phone || !network) return
    setIsFetchingName(true)
    setNameVerified(false)
    setWithdrawalForm(prev => ({ ...prev, accountName: "" }))
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const response = await fetch("/api/user/withdrawals/validate-account", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
        },
        body: JSON.stringify({ phone, network }),
      })
      const data = await response.json()
      if (response.ok && data.accountName) {
        setWithdrawalForm(prev => ({ ...prev, accountName: data.accountName }))
        setNameVerified(true)
      } else {
        toast.error(data.error || "Could not verify account. Check the phone number and network.")
      }
    } catch {
      toast.error("Failed to verify account. Please try again.")
    } finally {
      setIsFetchingName(false)
    }
  }

  const handleValidateBankAccount = async () => {
    const { accountNumber, bankSublistId } = withdrawalForm
    if (!accountNumber || !bankSublistId) {
      toast.error("Please select a bank and enter the account number")
      return
    }
    setIsFetchingBankName(true)
    setBankVerified(false)
    setWithdrawalForm(prev => ({ ...prev, accountName: "" }))
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const response = await fetch("/api/user/withdrawals/validate-account", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
        },
        body: JSON.stringify({ network: "BANK", accountNumber, sublistid: bankSublistId }),
      })
      const data = await response.json()
      if (response.ok && data.accountName) {
        setWithdrawalForm(prev => ({ ...prev, accountName: data.accountName }))
        setBankVerified(true)
      } else {
        toast.error(data.error || "Could not verify bank account. Check the account number and bank.")
      }
    } catch {
      toast.error("Failed to verify bank account. Please try again.")
    } finally {
      setIsFetchingBankName(false)
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

    if (withdrawalForm.method === "mobile_money" && !withdrawalForm.phone) {
      toast.error("Please enter your phone number")
      return
    }

    if (withdrawalForm.method === "mobile_money" && !nameVerified) {
      toast.error("Please verify your account name before submitting")
      return
    }

    if (withdrawalForm.method === "bank_transfer") {
      if (!withdrawalForm.bankName.trim() && !withdrawalForm.bankSublistId) {
        toast.error("Please select a bank")
        return
      }
      if (!withdrawalForm.accountNumber.trim()) {
        toast.error("Please enter the account number")
        return
      }
      if (!bankVerified) {
        toast.error("Please verify your bank account before submitting")
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
        accountDetails.sublistid = withdrawalForm.bankSublistId
        accountDetails.account_number = withdrawalForm.accountNumber
        accountDetails.account_name = withdrawalForm.accountName
      }

      // Create via the server route (service_role) so the withdrawal fee is read
      // reliably from the locked app_settings table. The old direct client call
      // intermittently ran the fee read as `anon` (42501) and silently set a 0 fee.
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) {
        throw new Error("Your session has expired. Please sign in again.")
      }
      const res = await fetch("/api/user/withdrawals/create", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          shopId: shop.id,
          amount,
          withdrawal_method: withdrawalForm.method,
          account_details: accountDetails,
        }),
      })
      const result = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(result?.error || "Failed to create withdrawal request")
      }

      toast.success("Withdrawal request submitted successfully")
      setWithdrawalForm({ amount: "", method: "mobile_money", phone: "", accountName: "", bankName: "", bankSublistId: "", accountNumber: "", network: "MTN" })
      setNameVerified(false)
      setBankVerified(false)
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
          <p className="text-muted-foreground">Loading dashboard...</p>
        </div>
      </DashboardLayout>
    )
  }

  if (!shop) {
    return (
      <DashboardLayout>
        <div className="space-y-6">
          <Alert className="border-border bg-red-50">
            <AlertCircle className="h-4 w-4 text-red-600" />
            <AlertDescription className="text-red-700">
              Shop not found. Please create a shop first.
            </AlertDescription>
          </Alert>
        </div>
      </DashboardLayout>
    )
  }

  const pendingWithdrawals = withdrawals.filter(w => w.status === "pending" || w.status === "processing")
  const completedWithdrawals = withdrawals.filter(w => w.status === "completed")

  return (
    <DashboardLayout>
      <div className="space-y-6">
        {/* Header */}
        <div>
          <h1 className="text-2xl sm:text-3xl md:text-4xl font-bold bg-gradient-to-r from-primary via-primary to-primary bg-clip-text text-transparent">Shop Dashboard</h1>
          <p className="text-muted-foreground mt-1">Track your profits and manage withdrawals</p>
        </div>

        {/* Stats Cards */}
        <div className="grid gap-2 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
          {/* Available Balance */}
          <Card className="hover:shadow-2xl transition-all duration-300 hover:-translate-y-1 border-l-4 border-l-cyan-500 bg-card backdrop-blur-xl border border-border">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Available Balance</CardTitle>
              <div className="bg-gradient-to-br from-primary/30 to-blue-400/20 backdrop-blur p-2 rounded-lg border border-border">
                <DollarSign className="h-4 w-4 text-primary" />
              </div>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold bg-gradient-to-r from-primary to-primary/80 bg-clip-text text-transparent">
                GHS {(balance || 0).toFixed(2)}
              </div>
              <p className="text-xs text-muted-foreground">Ready to withdraw</p>
            </CardContent>
          </Card>

          {/* Total Profit */}
          <Card className="hover:shadow-2xl transition-all duration-300 hover:-translate-y-1 border-l-4 border-l-success/30 bg-card backdrop-blur-xl border border-border">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Profit</CardTitle>
              <div className="bg-gradient-to-br from-success/30 to-success/20 backdrop-blur p-2 rounded-lg border border-border">
                <TrendingUp className="h-4 w-4 text-success" />
              </div>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-success">
                GHS {(totalProfit || 0).toFixed(2)}
              </div>
              <p className="text-xs text-muted-foreground">All time profit</p>
            </CardContent>
          </Card>

          {/* Total Orders */}
          <Card className="hover:shadow-2xl transition-all duration-300 hover:-translate-y-1 border-l-4 border-l-amber-500 bg-card backdrop-blur-xl border border-border">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Orders</CardTitle>
              <div className="bg-gradient-to-br from-amber-400/30 to-orange-400/20 backdrop-blur p-2 rounded-lg border border-border">
                <ShoppingCart className="h-4 w-4 text-amber-600" />
              </div>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-warning">
                {orders.length}
              </div>
              <p className="text-xs text-muted-foreground">All orders</p>
            </CardContent>
          </Card>

          {/* Pending Withdrawals */}
          <Card className="hover:shadow-2xl transition-all duration-300 hover:-translate-y-1 border-l-4 border-l-rose-500 bg-card backdrop-blur-xl border border-border">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Pending Withdrawals</CardTitle>
              <div className="bg-gradient-to-br from-rose-400/30 to-pink-400/20 backdrop-blur p-2 rounded-lg border border-border">
                <CreditCard className="h-4 w-4 text-rose-600" />
              </div>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-destructive">
                {pendingWithdrawals.length}
              </div>
              <p className="text-xs text-muted-foreground">Awaiting approval</p>
            </CardContent>
          </Card>
        </div>

        {/* Customer Stats Section */}
        <div className="grid gap-2 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5 pt-2">
            {/* Total Customers */}
            <Link href="/dashboard/customers">
              <Card className="hover:shadow-2xl transition-all duration-300 hover:-translate-y-1 border-l-4 border-l-indigo-500 bg-card backdrop-blur-xl border border-border cursor-pointer hover:border-border group">
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">Total Customers</CardTitle>
                  <div className="w-4 h-4 text-primary group-hover:translate-x-1 transition-transform duration-300">
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M5 12h14"></path>
                      <path d="m12 5 7 7-7 7"></path>
                    </svg>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold bg-gradient-to-r from-primary to-primary bg-clip-text text-transparent">
                    {customerStats.total_customers}
                  </div>
                  <p className="text-xs text-muted-foreground">Click to view customers</p>
                </CardContent>
              </Card>
            </Link>

            {/* Repeat Customers */}
            <Card className="hover:shadow-2xl transition-all duration-300 hover:-translate-y-1 border-l-4 border-l-pink-500 bg-card backdrop-blur-xl border border-border">
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Repeat Customers</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold text-destructive">
                  {customerStats.repeat_customers}
                </div>
                <p className="text-xs text-muted-foreground">
                  {customerStats.total_customers > 0 
                    ? `${(customerStats.repeat_percentage || 0).toFixed(1)}% of customers`
                    : "No customers yet"}
                </p>
              </CardContent>
            </Card>

            {/* New This Month */}
            <Card className="hover:shadow-2xl transition-all duration-300 hover:-translate-y-1 border-l-4 border-l-green-500 bg-card backdrop-blur-xl border border-border">
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">New This Month</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold text-success">
                  {customerStats.new_customers_month}
                </div>
                <p className="text-xs text-muted-foreground">Recent acquisitions</p>
              </CardContent>
            </Card>

            {/* Average LTV */}
            <Card className="hover:shadow-2xl transition-all duration-300 hover:-translate-y-1 border-l-4 border-l-blue-500 bg-card backdrop-blur-xl border border-primary/20">
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Avg. LTV</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold bg-gradient-to-r from-primary to-primary bg-clip-text text-transparent">
                  GHS {(customerStats.average_ltv || 0).toFixed(2)}
                </div>
                <p className="text-xs text-muted-foreground">Per customer</p>
              </CardContent>
            </Card>

            {/* Customer Revenue */}
            <Card className="hover:shadow-2xl transition-all duration-300 hover:-translate-y-1 border-l-4 border-l-orange-500 bg-card backdrop-blur-xl border border-border">
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Customer Revenue</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold text-warning">
                  GHS {(customerStats.total_revenue || 0).toFixed(2)}
                </div>
                <p className="text-xs text-muted-foreground">Total from customers</p>
              </CardContent>
            </Card>
        </div>

        {/* Withdraw Button */}
        {balance > 0 && !showWithdrawalForm && (
          <>
            {withdrawals.some(w => w.status === "pending" || w.status === "processing") ? (
              <div className="w-full p-4 bg-warning/10 border border-border rounded-lg">
                <p className="text-warning text-sm font-medium">
                  {withdrawals.some(w => w.status === "processing")
                    ? "⏳ Your withdrawal is being transferred. It will complete automatically."
                    : "⏳ You have a pending withdrawal request. Please wait for it to be approved or rejected before requesting another."}
                </p>
              </div>
            ) : (
              <Button
                onClick={() => setShowWithdrawalForm(true)}
                className="w-full bg-gradient-to-r from-primary to-primary hover:from-primary hover:to-primary"
              >
                Request Withdrawal
              </Button>
            )}
          </>
        )}

        {/* Withdrawal Form */}
        {showWithdrawalForm && (
          <Card className="bg-card backdrop-blur-xl border border-border">
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
                <p className="text-xs text-muted-foreground mt-1">
                  Available: GHS {(balance || 0).toFixed(2)} | Minimum: GHS 5.00
                </p>
              </div>

              <div>
                <Label>Withdrawal Method *</Label>
                <select
                  value={withdrawalForm.method}
                  onChange={(e) => {
                    setWithdrawalForm({ ...withdrawalForm, method: e.target.value, accountName: "", phone: "", network: "MTN", bankName: "", bankSublistId: "" })
                    setNameVerified(false)
                    setBankVerified(false)
                    if (e.target.value === "bank_transfer") fetchBanks()
                  }}
                  className="w-full mt-1 px-3 py-2 border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary"
                >
                  <option value="mobile_money">Mobile Money</option>
                  <option value="bank_transfer">Bank Transfer</option>
                </select>
              </div>

              {withdrawalForm.method === "mobile_money" && (
                <>
                  <div>
                    <Label>Network *</Label>
                    <select
                      value={withdrawalForm.network}
                      onChange={(e) => {
                        const newNetwork = e.target.value
                        setWithdrawalForm(prev => ({ ...prev, network: newNetwork, accountName: "" }))
                        setNameVerified(false)
                        if (withdrawalForm.phone) {
                          handleValidateAccount(withdrawalForm.phone, newNetwork)
                        }
                      }}
                      className="w-full mt-1 px-3 py-2 border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary"
                    >
                      <option value="MTN">MTN</option>
                      <option value="Telecel">Telecel</option>
                      <option value="AT">AirtelTigo (AT)</option>
                    </select>
                  </div>
                  <div>
                    <Label>Mobile Number *</Label>
                    <div className="flex gap-2 mt-1">
                      <Input
                        value={withdrawalForm.phone}
                        onChange={(e) => {
                          setWithdrawalForm(prev => ({ ...prev, phone: e.target.value, accountName: "" }))
                          setNameVerified(false)
                        }}
                        onBlur={(e) => {
                          if (e.target.value) {
                            handleValidateAccount(e.target.value, withdrawalForm.network)
                          }
                        }}
                        placeholder="0201234567"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        disabled={!withdrawalForm.phone || isFetchingName}
                        onClick={() => handleValidateAccount(withdrawalForm.phone, withdrawalForm.network)}
                        className="shrink-0 border-border text-primary hover:bg-primary"
                      >
                        {isFetchingName ? <Loader2 className="h-4 w-4 animate-spin" /> : "Verify"}
                      </Button>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">
                      Enter your number and click <span className="font-medium text-primary">Verify</span> to confirm the account name before submitting.
                    </p>
                    {nameVerified && withdrawalForm.accountName && (
                      <p className="text-xs text-success mt-1 flex items-center gap-1 font-medium">
                        <CheckCircle className="h-3 w-3" /> Account: {withdrawalForm.accountName}
                      </p>
                    )}
                    {!nameVerified && !isFetchingName && withdrawalForm.phone && (
                      <p className="text-xs text-warning mt-1">
                        Account not yet verified — click Verify to proceed.
                      </p>
                    )}
                  </div>
                </>
              )}

              {withdrawalForm.method === "bank_transfer" && (
                <>
                  <div>
                    <Label>Bank *</Label>
                    {loadingBanks ? (
                      <div className="mt-1 flex items-center gap-2 text-sm text-muted-foreground">
                        <Loader2 className="h-4 w-4 animate-spin" /> Loading banks...
                      </div>
                    ) : banks.length > 0 ? (
                      <select
                        value={withdrawalForm.bankSublistId}
                        onChange={(e) => {
                          const selected = banks.find(b => b.sublistid === e.target.value)
                          setWithdrawalForm({
                            ...withdrawalForm,
                            bankSublistId: e.target.value,
                            bankName: selected?.name ?? "",
                            accountName: "",
                          })
                          setBankVerified(false)
                        }}
                        className="w-full mt-1 px-3 py-2 border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary"
                      >
                        <option value="">Select a bank...</option>
                        {banks.map(b => (
                          <option key={b.sublistid} value={b.sublistid}>{b.name}</option>
                        ))}
                      </select>
                    ) : (
                      <Input
                        value={withdrawalForm.bankName}
                        onChange={(e) => setWithdrawalForm({ ...withdrawalForm, bankName: e.target.value })}
                        placeholder="e.g., GCB, Zenith Bank"
                        className="mt-1"
                      />
                    )}
                  </div>
                  <div>
                    <Label>Account Number *</Label>
                    <div className="flex gap-2 mt-1">
                      <Input
                        value={withdrawalForm.accountNumber}
                        onChange={(e) => {
                          setWithdrawalForm(prev => ({ ...prev, accountNumber: e.target.value, accountName: "" }))
                          setBankVerified(false)
                        }}
                        placeholder="1234567890"
                        className="flex-1"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        disabled={!withdrawalForm.accountNumber || !withdrawalForm.bankSublistId || isFetchingBankName}
                        onClick={handleValidateBankAccount}
                        className="shrink-0 border-border text-primary hover:bg-primary"
                      >
                        {isFetchingBankName ? <Loader2 className="h-4 w-4 animate-spin" /> : "Verify"}
                      </Button>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">
                      Select your bank, enter account number, then click <span className="font-medium text-primary">Verify</span> to confirm.
                    </p>
                    {bankVerified && withdrawalForm.accountName && (
                      <p className="text-xs text-success mt-1 flex items-center gap-1 font-medium">
                        <CheckCircle className="h-3 w-3" /> Account: {withdrawalForm.accountName}
                      </p>
                    )}
                    {!bankVerified && !isFetchingBankName && withdrawalForm.accountNumber && withdrawalForm.bankSublistId && (
                      <p className="text-xs text-warning mt-1">
                        Account not yet verified — click Verify to proceed.
                      </p>
                    )}
                  </div>
                </>
              )}

              {withdrawalForm.amount && parseFloat(withdrawalForm.amount) > 0 && (
                <div className="bg-warning/10 border border-border rounded-lg p-3 space-y-2">
                  <h4 className="font-semibold text-sm text-warning">Withdrawal Breakdown</h4>
                  <div className="text-sm space-y-1">
                    <div className="flex justify-between">
                      <span className="text-warning">Requested amount:</span>
                      <span className="font-medium text-warning">GHS {parseFloat(withdrawalForm.amount).toFixed(2)}</span>
                    </div>
                    {withdrawalFeePercentage > 0 && (
                      <>
                        <div className="flex justify-between">
                          <span className="text-warning">Withdrawal fee ({withdrawalFeePercentage}%):</span>
                          <span className="font-medium text-warning">-GHS {(parseFloat(withdrawalForm.amount) * withdrawalFeePercentage / 100).toFixed(2)}</span>
                        </div>
                        <div className="border-t border-border pt-1 flex justify-between">
                          <span className="text-warning font-semibold">You will receive:</span>
                          <span className="font-bold text-success">GHS {(parseFloat(withdrawalForm.amount) - (parseFloat(withdrawalForm.amount) * withdrawalFeePercentage / 100)).toFixed(2)}</span>
                        </div>
                      </>
                    )}
                  </div>
                </div>
              )}

              <Alert className="border-border bg-primary/5">
                <AlertCircle className="h-4 w-4 text-primary" />
                <AlertDescription className="text-xs text-primary">
                  Withdrawal requests are processed within 1-2 business days after approval.
                </AlertDescription>
              </Alert>

              <div className="flex gap-2">
                <Button
                  onClick={handleWithdrawal}
                  disabled={isSubmitting || isFetchingName || isFetchingBankName || (withdrawalForm.method === "mobile_money" && !nameVerified) || (withdrawalForm.method === "bank_transfer" && !bankVerified)}
                  className="flex-1 bg-primary hover:bg-primary"
                >
                  {isSubmitting ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin mr-2" />
                      Submitting...
                    </>
                  ) : (
                    "Submit Request"
                  )}
                </Button>
                <Button
                  onClick={() => {
                    setShowWithdrawalForm(false)
                    setNameVerified(false)
                    setBankVerified(false)
                  }}
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
          <TabsList className="bg-card/40 backdrop-blur border border-white/20 flex-wrap h-auto gap-1">
            <TabsTrigger value="orders">Recent Orders ({orders.length})</TabsTrigger>
            <TabsTrigger value="profits">Profit History ({profits.length})</TabsTrigger>
            <TabsTrigger value="withdrawals">Withdrawals ({withdrawals.length})</TabsTrigger>
            <TabsTrigger value="store-overview">Store Overview</TabsTrigger>
          </TabsList>

          {/* Orders Tab */}
          <TabsContent value="orders">
            <Card className="bg-card backdrop-blur-xl border border-border">
              <CardHeader>
                <CardTitle>Recent Orders</CardTitle>
                <CardDescription>Orders from your shop customers</CardDescription>
              </CardHeader>
              <CardContent>
                {orders.length === 0 ? (
                  <p className="text-muted-foreground text-center py-8">No orders yet. Share your shop link to start receiving orders!</p>
                ) : (
                  <div className="space-y-3 max-h-96 overflow-y-auto">
                    {orders.map((order) => (
                      <div
                        key={order.id}
                        className="flex items-center justify-between p-3 bg-card/50 border border-border rounded-lg hover:bg-card/70"
                      >
                        <div className="flex-1">
                          <p className="font-semibold">{order.customer_name}</p>
                          <p className="text-sm text-muted-foreground">{order.network} - {order.volume_gb}GB</p>
                          <p className="text-xs text-muted-foreground">
                            {new Date(order.created_at).toLocaleDateString()} {new Date(order.created_at).toLocaleTimeString()}
                          </p>
                        </div>
                        <div className="text-right">
                          <p className="font-semibold text-primary">+GHS {(order.profit_amount || 0).toFixed(2)}</p>
                          <Badge variant="outline" className={
                            order.order_status === "completed"
                              ? "bg-success/15 text-success"
                              : "bg-warning/10 text-warning"
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
            <Card className="bg-card backdrop-blur-xl border border-border">
              <CardHeader>
                <CardTitle>Profit History</CardTitle>
                <CardDescription>Detailed breakdown of your profits by transaction</CardDescription>
              </CardHeader>
              <CardContent>
                {profits.length === 0 ? (
                  <p className="text-muted-foreground text-center py-8">No profit history yet. Complete orders to start earning!</p>
                ) : (
                  <div className="space-y-3 max-h-96 overflow-y-auto">
                    {profits.map((profit: any) => {
                      const profitAmount = profit.profit_amount || profit.amount || 0
                      return (
                      <div
                        key={profit.id}
                        className="flex items-center justify-between p-3 bg-card/50 border border-border rounded-lg hover:bg-card/70"
                      >
                        <div className="flex-1">
                          <p className="font-semibold">GHS {(profitAmount || 0).toFixed(2)}</p>
                          <p className="text-sm text-muted-foreground">{profit.profit_type || "Order Profit"}</p>
                          <p className="text-xs text-muted-foreground">{new Date(profit.created_at).toLocaleDateString()}</p>
                        </div>
                        <div className="text-right">
                          <Badge className="bg-success">
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
            <Card className="bg-card backdrop-blur-xl border border-border">
              <CardHeader>
                <CardTitle>Withdrawal History</CardTitle>
                <CardDescription>Your withdrawal requests and status</CardDescription>
              </CardHeader>
              <CardContent>
                {withdrawals.length === 0 ? (
                  <p className="text-muted-foreground text-center py-8">No withdrawals yet.</p>
                ) : (
                  <div className="space-y-3 max-h-96 overflow-y-auto">
                    {withdrawals.map((withdrawal) => (
                      <div
                        key={withdrawal.id}
                        className="flex items-center justify-between p-3 bg-card/50 border border-border rounded-lg"
                      >
                        <div className="flex-1">
                          <p className="font-semibold">GHS {(withdrawal.amount || 0).toFixed(2)}</p>
                          <p className="text-sm text-muted-foreground">{withdrawal.withdrawal_method}</p>
                          <p className="text-xs text-muted-foreground">{new Date(withdrawal.created_at).toLocaleDateString()}</p>
                        </div>
                        <Badge className={
                          withdrawal.status === "completed"
                            ? "bg-success"
                            : withdrawal.status === "processing"
                            ? "bg-primary"
                            : withdrawal.status === "pending"
                            ? "bg-warning"
                            : withdrawal.status === "approved"
                            ? "bg-primary"
                            : withdrawal.status === "failed"
                            ? "bg-destructive"
                            : "bg-gray-500"
                        }>
                          {withdrawal.status === "processing" ? "Transferring..." : withdrawal.status}
                        </Badge>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* Store Overview Tab */}
          <TabsContent value="store-overview">
            <div className="space-y-6">
              {/* Stats Grid */}
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2 sm:gap-4">
                <Card className="bg-card">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-medium text-muted-foreground">Total Orders</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-3xl font-bold text-primary">{orderStats.total}</p>
                  </CardContent>
                </Card>

                <Card className="bg-card">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-medium text-muted-foreground">Completed</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-3xl font-bold text-success">{orderStats.completed}</p>
                  </CardContent>
                </Card>

                <Card className="bg-card">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-medium text-muted-foreground">Pending</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-3xl font-bold text-warning">{orderStats.pending}</p>
                  </CardContent>
                </Card>

                <Card className="bg-card">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-medium text-muted-foreground">Failed</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-3xl font-bold text-destructive">{orderStats.failed}</p>
                  </CardContent>
                </Card>

                <Card className="bg-card">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-medium text-muted-foreground">Total Revenue</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-3xl font-bold text-primary">GHS {orderStats.totalRevenue.toFixed(2)}</p>
                  </CardContent>
                </Card>
              </div>

              {/* Orders Table */}
              <Card className="bg-card backdrop-blur-xl border border-border">
                <CardHeader>
                  <CardTitle>Recent Orders</CardTitle>
                  <CardDescription>
                    {orders.length === 0
                      ? "No orders yet. Your first customer purchase will appear here."
                      : `Showing ${orders.length} order${orders.length !== 1 ? "s" : ""}`}
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  {orders.length > 0 && (
                    <div className="flex gap-2">
                      <Search className="w-5 h-5 text-muted-foreground mt-2.5" />
                      <Input
                        type="text"
                        placeholder="Search orders by customer phone number..."
                        value={searchPhoneNumber}
                        onChange={(e) => setSearchPhoneNumber(e.target.value)}
                        className="bg-card/50 border-border"
                      />
                    </div>
                  )}
                  {orders.length === 0 ? (
                    <Alert className="border-border bg-primary/5">
                      <AlertCircle className="h-4 w-4 text-primary" />
                      <AlertDescription className="text-primary">
                        Order analytics and management will show here once your first customer makes a purchase.
                      </AlertDescription>
                    </Alert>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead className="border-b border-border">
                          <tr>
                            <th className="text-left py-3 px-4 font-semibold text-foreground">Order ID</th>
                            <th className="text-left py-3 px-4 font-semibold text-foreground">Customer</th>
                            <th className="text-left py-3 px-4 font-semibold text-foreground">Network</th>
                            <th className="text-left py-3 px-4 font-semibold text-foreground">Volume</th>
                            <th className="text-left py-3 px-4 font-semibold text-foreground">Status</th>
                            <th className="text-right py-3 px-4 font-semibold text-foreground">Profit</th>
                            <th className="text-left py-3 px-4 font-semibold text-foreground">Date</th>
                            <th className="text-left py-3 px-4 font-semibold text-foreground">Actions</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-primary/40">
                          {orders
                            .filter((order) =>
                              !searchPhoneNumber ||
                              (order.customer_phone || "").toLowerCase().includes(searchPhoneNumber.toLowerCase())
                            )
                            .map((order: any) => (
                              <tr key={order.id} className="hover:bg-primary/30 transition-colors">
                                <td className="py-3 px-4 font-mono text-xs text-muted-foreground">{order.reference_code}</td>
                                <td className="py-3 px-4">
                                  <div>
                                    <p className="font-medium text-foreground">{order.customer_name || "N/A"}</p>
                                    <p className="text-xs text-muted-foreground">{order.customer_phone}</p>
                                  </div>
                                </td>
                                <td className="py-3 px-4">
                                  <Badge variant="outline">{order.network}</Badge>
                                </td>
                                <td className="py-3 px-4 text-foreground">{order.volume_gb} GB</td>
                                <td className="py-3 px-4">
                                  <Badge className={
                                    order.order_status === "completed" ? "bg-success" :
                                      order.order_status === "pending" ? "bg-warning" :
                                        "bg-destructive"
                                  }>
                                    {order.order_status}
                                  </Badge>
                                </td>
                                <td className="py-3 px-4 text-right font-semibold text-primary">
                                  GHS {(order.profit_amount || 0).toFixed(2)}
                                </td>
                                <td className="py-3 px-4 text-xs text-muted-foreground">
                                  <div>{new Date(order.created_at).toLocaleDateString()}</div>
                                  <div className="text-xs text-muted-foreground">{new Date(order.created_at).toLocaleTimeString()}</div>
                                </td>
                                <td className="py-3 px-4">
                                  {order.order_status === "completed" &&
                                    order.updated_at &&
                                    Date.now() - new Date(order.updated_at).getTime() >= 30 * 60 * 1000 && (
                                    <Button
                                      onClick={() => {
                                        setSelectedComplaintOrder({
                                          id: order.id,
                                          networkName: order.network || "Unknown",
                                          packageName: `${order.volume_gb || 0}GB`,
                                          phoneNumber: order.customer_phone || "N/A",
                                          totalPrice: parseFloat(order.total_price?.toString() || "0") || 0,
                                          createdAt: order.created_at || new Date().toISOString(),
                                        })
                                        setShowComplaintModal(true)
                                      }}
                                      variant="outline"
                                      size="sm"
                                      className="text-warning border-warning/30 hover:bg-warning/10"
                                    >
                                      <MessageCircle className="w-4 h-4 mr-1" />
                                      Complain
                                    </Button>
                                  )}
                                </td>
                              </tr>
                            ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          </TabsContent>
        </Tabs>
      </div>

      {selectedComplaintOrder && (
        <ComplaintModal
          isOpen={showComplaintModal}
          onClose={() => {
            setShowComplaintModal(false)
            setSelectedComplaintOrder(null)
          }}
          orderId={selectedComplaintOrder.id}
          orderType="shop"
          orderDetails={selectedComplaintOrder}
        />
      )}
    </DashboardLayout>
  )
}
