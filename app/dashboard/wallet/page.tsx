"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Wallet, Plus, Minus, TrendingUp, TrendingDown, AlertCircle, Loader2 } from "lucide-react"
import { WalletTopUp } from "@/components/wallet-top-up"
import { supabase } from "@/lib/supabase"
import { toast } from "sonner"

interface WalletData {
  balance: number
  totalCredited: number
  totalDebited: number
  transactionCount: number
}

interface Transaction {
  id: string
  created_at: string
  type: string
  amount: number
  description: string
  reference: string
}

export default function WalletPage() {
  const router = useRouter()
  const [userId, setUserId] = useState<string | null>(null)
  const [walletData, setWalletData] = useState<WalletData>({
    balance: 0,
    totalCredited: 0,
    totalDebited: 0,
    transactionCount: 0,
  })
  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [loading, setLoading] = useState(true)
  const [showTopUp, setShowTopUp] = useState(false)

  useEffect(() => {
    fetchUserAndWallet()
  }, [])

  const fetchUserAndWallet = async () => {
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) {
        router.push("/auth/login")
        return
      }

      setUserId(user.id)
      await Promise.all([
        fetchWalletData(user.id),
        fetchTransactions(user.id),
      ])
    } catch (error) {
      console.error("Error fetching user:", error)
      toast.error("Failed to load wallet data")
    } finally {
      setLoading(false)
    }
  }

  const fetchWalletData = async (userId: string) => {
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) throw new Error("No session token")

      const response = await fetch("/api/wallet/balance", {
        headers: {
          "Authorization": `Bearer ${session.access_token}`,
        },
      })
      if (!response.ok) {
        const errorData = await response.json()
        throw new Error(errorData.error || "Failed to fetch wallet")
      }

      const data = await response.json()
      setWalletData(data)
    } catch (error) {
      console.error("Error fetching wallet data:", error)
      toast.error("Failed to load wallet balance")
    }
  }

  const fetchTransactions = async (userId: string) => {
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) throw new Error("No session token")

      const response = await fetch("/api/wallet/transactions?limit=10", {
        headers: {
          "Authorization": `Bearer ${session.access_token}`,
        },
      })
      if (!response.ok) {
        const errorData = await response.json()
        throw new Error(errorData.error || "Failed to fetch transactions")
      }

      const data = await response.json()
      setTransactions(data.transactions || [])
    } catch (error) {
      console.error("Error fetching transactions:", error)
      toast.error("Failed to load transaction history")
    }
  }

  const handleTopUpSuccess = async (amount: number) => {
    console.log("[WALLET-PAGE] Top up successful, amount:", amount)
    toast.success(`Wallet topped up by GHS ${amount.toFixed(2)}`)
    setShowTopUp(false)
    
    if (userId) {
      console.log("[WALLET-PAGE] Refetching wallet data and transactions...")
      // Wait a bit more to ensure data is written
      await new Promise(resolve => setTimeout(resolve, 500))
      await Promise.all([
        fetchWalletData(userId),
        fetchTransactions(userId),
      ])
      console.log("[WALLET-PAGE] Wallet data refreshed")
    }
  }

  if (loading) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center min-h-screen">
          <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
        </div>
      </DashboardLayout>
    )
  }
  return (
    <DashboardLayout>
      <div className="space-y-6">
        {/* Page Header */}
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Wallet</h1>
          <p className="text-gray-600 mt-1">Manage your account balance and funds</p>
        </div>

        {/* Balance Card */}
        <Card className="bg-gradient-to-r from-blue-600 to-purple-600 text-white border-0">
          <CardHeader>
            <CardTitle className="text-white">Current Balance</CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-blue-100 text-sm">Available Balance</p>
                <p className="text-4xl font-bold">GHS {walletData.balance.toFixed(2)}</p>
              </div>
              <Wallet className="w-16 h-16 text-blue-100 opacity-50" />
            </div>
            <div className="flex gap-4">
              <Button 
                onClick={() => setShowTopUp(!showTopUp)}
                className="bg-white text-blue-600 hover:bg-gray-100 flex-1"
              >
                <Plus className="w-4 h-4 mr-2" />
                Add Funds
              </Button>
              <Button variant="outline" className="border-white text-white hover:bg-white/20 flex-1" disabled>
                <Minus className="w-4 h-4 mr-2" />
                Withdraw
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Top Up Form */}
        {showTopUp && (
          <div className="animate-in fade-in slide-in-from-top-2">
            <WalletTopUp onSuccess={handleTopUpSuccess} />
          </div>
        )}

        {/* Stats Cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Credited</CardTitle>
              <TrendingUp className="h-4 w-4 text-green-600" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">GHS {walletData.totalCredited.toFixed(2)}</div>
              <p className="text-xs text-gray-600">All deposits</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Spent</CardTitle>
              <TrendingDown className="h-4 w-4 text-red-600" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">GHS {walletData.totalDebited.toFixed(2)}</div>
              <p className="text-xs text-gray-600">All purchases</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Available Balance</CardTitle>
              <Wallet className="h-4 w-4 text-blue-600" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">GHS {walletData.balance.toFixed(2)}</div>
              <p className="text-xs text-gray-600">Ready to use</p>
            </CardContent>
          </Card>
        </div>

        {/* Transaction History */}
        <Card>
          <CardHeader>
            <CardTitle>Transaction History</CardTitle>
            <CardDescription>
              {transactions.length === 0 ? "No transactions yet" : `Your recent ${transactions.length} transactions`}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {transactions.length === 0 ? (
              <Alert>
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>No transactions found. Start by adding funds to your wallet.</AlertDescription>
              </Alert>
            ) : (
              <>
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead className="bg-gray-50 border-b">
                      <tr>
                        <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">Date</th>
                        <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">Description</th>
                        <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">Amount</th>
                        <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">Type</th>
                        <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">Reference</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {transactions.map((transaction) => (
                        <tr key={transaction.id} className="hover:bg-gray-50">
                          <td className="px-6 py-4 text-sm">
                            {new Date(transaction.created_at).toLocaleDateString()}
                          </td>
                          <td className="px-6 py-4 text-sm">{transaction.description}</td>
                          <td className={`px-6 py-4 text-sm font-semibold ${
                            transaction.type === "credit" ? "text-green-600" : "text-red-600"
                          }`}>
                            {transaction.type === "credit" ? "+" : "-"}GHS {transaction.amount.toFixed(2)}
                          </td>
                          <td className="px-6 py-4 text-sm">
                            <Badge className={
                              transaction.type === "credit"
                                ? "bg-green-100 text-green-800"
                                : "bg-red-100 text-red-800"
                            }>
                              {transaction.type.charAt(0).toUpperCase() + transaction.type.slice(1)}
                            </Badge>
                          </td>
                          <td className="px-6 py-4 text-sm font-mono text-gray-600">
                            {transaction.reference?.slice(-8) || "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="mt-4 flex justify-between items-center">
                  <p className="text-sm text-gray-600">Showing {transactions.length} transaction(s)</p>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  )
}