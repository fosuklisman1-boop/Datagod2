"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { Trash2, Eye, Shield, Download, Loader2, Wallet, ShoppingCart, Store, ArrowDownCircle, TrendingUp, Clock, CheckCircle, XCircle, AlertCircle } from "lucide-react"
import { adminUserService } from "@/lib/admin-service"
import { supabase } from "@/lib/supabase"
import { toast } from "sonner"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ScrollArea } from "@/components/ui/scroll-area"

interface User {
  id: string
  email: string
  phoneNumber: string
  created_at: string
  role: string
  balance: number
  walletBalance: number
  shopBalance: number
  shop?: any
  customerCount?: number
  subAgentCount?: number
}

interface UserStats {
  userId: string
  wallet: {
    balance: number
    totalTopUps: number
    totalSpent: number
    transactionCount: number
  }
  orders: {
    total: number
    completed: number
    failed: number
    pending: number
  }
  shop: {
    shopId: string
    shopName: string
    shopSlug: string
    createdAt: string
    totalOrders: number
    paidOrders: number
    completedOrders: number
    totalSales: number
    totalProfit: number
    availableBalance: number
    withdrawnAmount: number
    pendingProfit: number
    creditedProfit: number
    profitRecords: number
  } | null
  withdrawals: {
    history: Array<{
      id: string
      amount: number
      feeAmount: number
      netAmount: number
      status: string
      method: string
      createdAt: string
      referenceCode: string
    }>
    totalWithdrawn: number
    pendingCount: number
    completedCount: number
  }
}

export default function AdminUsersPage() {
  const router = useRouter()
  const [users, setUsers] = useState<User[]>([])
  const [filteredUsers, setFilteredUsers] = useState<User[]>([])
  const [loading, setLoading] = useState(true)
  const [isAdmin, setIsAdmin] = useState(false)
  const [searchTerm, setSearchTerm] = useState("")
  const [selectedUser, setSelectedUser] = useState<User | null>(null)
  const [showDetailsDialog, setShowDetailsDialog] = useState(false)
  const [showBalanceDialog, setShowBalanceDialog] = useState(false)
  const [balanceAction, setBalanceAction] = useState<"credit" | "debit">("credit")
  const [balanceAmount, setBalanceAmount] = useState("")
  const [newRole, setNewRole] = useState("")
  const [showChangePasswordDialog, setShowChangePasswordDialog] = useState(false)
  const [newPassword, setNewPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")
  const [isChangingPassword, setIsChangingPassword] = useState(false)
  const [userStats, setUserStats] = useState<UserStats | null>(null)
  const [statsLoading, setStatsLoading] = useState(false)

  useEffect(() => {
    checkAdminAccess()
  }, [])

  useEffect(() => {
    filterUsers()
  }, [users, searchTerm])

  const checkAdminAccess = async () => {
    try {
      const { data: { user } } = await supabase.auth.getUser()
      const role = user?.user_metadata?.role

      if (role !== "admin") {
        toast.error("Unauthorized access")
        router.push("/dashboard")
        return
      }

      setIsAdmin(true)
      await loadUsers()
    } catch (error) {
      console.error("Error checking admin access:", error)
      router.push("/dashboard")
    }
  }

  const loadUsers = async () => {
    try {
      const data = await adminUserService.getAllUsers()
      setUsers(data || [])
    } catch (error) {
      console.error("Error loading users:", error)
      const errorMessage = error instanceof Error ? error.message : "Failed to load users"
      toast.error(errorMessage)
    } finally {
      setLoading(false)
    }
  }

  const filterUsers = () => {
    if (!searchTerm.trim()) {
      setFilteredUsers(users)
      return
    }

    const searchLower = searchTerm.toLowerCase()
    const filtered = users.filter((user) => {
      const emailMatch = user.email.toLowerCase().includes(searchLower)
      const phoneMatch = user.phoneNumber?.toLowerCase().includes(searchLower)
      const shopNameMatch = user.shop?.shop_name?.toLowerCase().includes(searchLower)
      return emailMatch || phoneMatch || shopNameMatch
    })

    setFilteredUsers(filtered)
  }

  const loadUserStats = async (userId: string) => {
    try {
      setStatsLoading(true)
      setUserStats(null)
      
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) {
        toast.error("Session expired")
        return
      }

      const response = await fetch(`/api/admin/users/${userId}/stats`, {
        headers: {
          "Authorization": `Bearer ${session.access_token}`
        }
      })

      if (!response.ok) {
        throw new Error("Failed to load user stats")
      }

      const stats = await response.json()
      setUserStats(stats)
    } catch (error) {
      console.error("Error loading user stats:", error)
      toast.error("Failed to load user statistics")
    } finally {
      setStatsLoading(false)
    }
  }

  const handleUpdateRole = async () => {
    if (!selectedUser || !newRole) {
      toast.error("Please select a role")
      return
    }

    try {
      await adminUserService.updateUserRole(selectedUser.id, newRole)
      toast.success(`User role updated to ${newRole}. They will need to log out and log back in to access the new permissions.`)
      setNewRole("")
      await loadUsers()
      setShowDetailsDialog(false)
    } catch (error: any) {
      console.error("Error updating role:", error)
      toast.error(error.message || "Failed to update role")
    }
  }

  const handleUpdateBalance = async () => {
    if (!selectedUser || !balanceAmount) {
      toast.error("Please enter an amount")
      return
    }

    try {
      if (!selectedUser.shop?.id) {
        toast.error("User has no shop")
        return
      }

      await adminUserService.updateUserBalance(
        selectedUser.shop.id,
        parseFloat(balanceAmount),
        balanceAction
      )

      toast.success(`Balance ${balanceAction === "credit" ? "credited" : "debited"} successfully`)
      setBalanceAmount("")
      await loadUsers()
      setShowBalanceDialog(false)
    } catch (error: any) {
      console.error("Error updating balance:", error)
      toast.error(error.message || "Failed to update balance")
    }
  }

  const handleChangePassword = async () => {
    if (!selectedUser || !newPassword) {
      toast.error("Please enter a new password")
      return
    }

    if (newPassword !== confirmPassword) {
      toast.error("Passwords do not match")
      return
    }

    if (newPassword.length < 6) {
      toast.error("Password must be at least 6 characters")
      return
    }

    setIsChangingPassword(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) {
        toast.error("Session expired. Please refresh the page.")
        setIsChangingPassword(false)
        return
      }

      await adminUserService.changeUserPassword(
        selectedUser.id,
        newPassword,
        session
      )

      toast.success("Password changed successfully")
      setNewPassword("")
      setConfirmPassword("")
      setShowChangePasswordDialog(false)
    } catch (error: any) {
      console.error("Error changing password:", error)
      toast.error(error.message || "Failed to change password")
    } finally {
      setIsChangingPassword(false)
    }
  }

  const handleRemoveUser = async (userId: string) => {
    if (!confirm("Are you sure you want to permanently delete this user?")) return

    try {
      await adminUserService.removeUser(userId)
      toast.success("User removed successfully")
      await loadUsers()
    } catch (error: any) {
      console.error("Error removing user:", error)
      toast.error(error.message || "Failed to remove user")
    }
  }

  const downloadAsCSV = (filename: string, data: string) => {
    const element = document.createElement("a")
    element.setAttribute("href", "data:text/csv;charset=utf-8," + encodeURIComponent(data))
    element.setAttribute("download", filename)
    element.style.display = "none"
    document.body.appendChild(element)
    element.click()
    document.body.removeChild(element)
  }

  const handleDownloadEmails = () => {
    try {
      const headers = ["Email"]
      const rows = filteredUsers.map((user) => [user.email])
      const csv = [headers, ...rows].map((row) => row.join(",")).join("\n")
      downloadAsCSV(`emails_${new Date().toISOString().split("T")[0]}.csv`, csv)
      toast.success("Emails downloaded successfully")
    } catch (error) {
      console.error("Error downloading emails:", error)
      const errorMessage = error instanceof Error ? error.message : "Failed to download emails"
      toast.error(errorMessage)
    }
  }

  const handleDownloadPhoneNumbers = () => {
    try {
      const headers = ["Phone Number"]
      const rows = filteredUsers.map((user) => [user.phoneNumber || ""])
      const csv = [headers, ...rows].map((row) => row.join(",")).join("\n")
      downloadAsCSV(`phone_numbers_${new Date().toISOString().split("T")[0]}.csv`, csv)
      toast.success("Phone numbers downloaded successfully")
    } catch (error) {
      console.error("Error downloading phone numbers:", error)
      const errorMessage = error instanceof Error ? error.message : "Failed to download phone numbers"
      toast.error(errorMessage)
    }
  }

  const handleDownloadAll = () => {
    try {
      const headers = ["Email", "Phone Number", "Role", "Wallet Balance (GHS)", "Shop Balance (GHS)", "Shop Name", "Total Customers", "Joined Date"]
      const rows = filteredUsers.map((user) => [
        user.email,
        user.phoneNumber || "",
        user.role,
        user.walletBalance.toFixed(2),
        user.shopBalance.toFixed(2),
        user.shop?.shop_name || "",
        user.customerCount || 0,
        new Date(user.created_at).toLocaleDateString(),
      ])
      const csv = [headers, ...rows].map((row) => row.map((cell) => `"${cell}"`).join(",")).join("\n")
      downloadAsCSV(`all_users_${new Date().toISOString().split("T")[0]}.csv`, csv)
      toast.success("User data downloaded successfully")
    } catch (error) {
      console.error("Error downloading user data:", error)
      const errorMessage = error instanceof Error ? error.message : "Failed to download user data"
      toast.error(errorMessage)
    }
  }

  if (!isAdmin) return null

  return (
    <DashboardLayout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h1 className="text-2xl sm:text-3xl md:text-4xl font-bold bg-gradient-to-r from-emerald-600 to-teal-600 bg-clip-text text-transparent">User Management</h1>
            <p className="text-gray-500 mt-1">Manage user roles, balances, and account status</p>
          </div>
          <div className="flex flex-col sm:flex-row gap-2">
            <Button
              onClick={handleDownloadEmails}
              variant="outline"
              className="text-sm gap-2"
              title="Download all email addresses"
            >
              <Download className="w-4 h-4" />
              Download Emails
            </Button>
            <Button
              onClick={handleDownloadPhoneNumbers}
              variant="outline"
              className="text-sm gap-2"
              title="Download all phone numbers"
            >
              <Download className="w-4 h-4" />
              Download Phones
            </Button>
            <Button
              onClick={handleDownloadAll}
              variant="outline"
              className="text-sm gap-2"
              title="Download all user data"
            >
              <Download className="w-4 h-4" />
              Download All
            </Button>
          </div>
        </div>

        {/* Users Table */}
        <Card className="bg-gradient-to-br from-emerald-50/60 to-teal-50/40 backdrop-blur-xl border border-emerald-200/40">
          <CardHeader>
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
              <div>
                <CardTitle>All Users ({filteredUsers.length})</CardTitle>
                <CardDescription>Manage user roles, balances, and account status</CardDescription>
              </div>
              <div className="w-full sm:w-64">
                <Input
                  placeholder="Search by email, phone or shop..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="border-emerald-200/40 focus:border-emerald-500"
                />
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-gradient-to-r from-emerald-100/60 to-teal-100/60 backdrop-blur border-b border-emerald-200/40">
                  <tr>
                    <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">Email</th>
                    <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">Phone</th>
                    <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">Role</th>
                    <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">Wallet Balance</th>
                    <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">Shop Balance</th>
                    <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">Shop</th>
                    <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">Total Customers</th>
                    <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">Sub-Agents</th>
                    <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">Joined</th>
                    <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-emerald-100/40">
                  {filteredUsers.length === 0 ? (
                    <tr>
                      <td colSpan={10} className="px-6 py-8 text-center text-gray-500">
                        {searchTerm ? "No users found matching your search" : "No users found"}
                      </td>
                    </tr>
                  ) : (
                    filteredUsers.map((user) => (
                    <tr key={user.id} className="hover:bg-emerald-100/30 backdrop-blur transition-colors">
                      <td className="px-6 py-4 font-medium text-gray-900">{user.email}</td>
                      <td className="px-6 py-4 text-sm text-gray-600">{user.phoneNumber || "-"}</td>
                      <td className="px-6 py-4">
                        <Badge className={user.role === "admin" ? "bg-red-600" : "bg-blue-600"}>
                          {user.role}
                        </Badge>
                      </td>
                      <td className="px-6 py-4 font-semibold text-blue-600">GHS {(user.walletBalance || 0).toFixed(2)}</td>
                      <td className="px-6 py-4 font-semibold text-emerald-600">GHS {(user.shopBalance || 0).toFixed(2)}</td>
                      <td className="px-6 py-4 text-sm text-gray-600">{user.shop?.shop_name || "No shop"}</td>
                      <td className="px-6 py-4 text-sm text-gray-600">
                        <Badge className="bg-blue-500">
                          {user.customerCount || 0}
                        </Badge>
                      </td>
                      <td className="px-6 py-4 text-sm text-gray-600">
                        <Badge className="bg-purple-500">
                          {user.subAgentCount || 0}
                        </Badge>
                      </td>
                      <td className="px-6 py-4 text-sm text-gray-600">{new Date(user.created_at).toLocaleDateString()}</td>
                      <td className="px-6 py-4 flex gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setSelectedUser(user)
                            setNewRole(user.role)
                            setShowDetailsDialog(true)
                            loadUserStats(user.id)
                          }}
                          className="text-emerald-600 hover:text-emerald-700 hover:bg-emerald-50"
                        >
                          <Eye className="w-4 h-4" />
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setSelectedUser(user)
                            setShowBalanceDialog(true)
                          }}
                          className="text-blue-600 hover:text-blue-700 hover:bg-blue-50"
                        >
                          <Shield className="w-4 h-4" />
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => handleRemoveUser(user.id)}
                          className="text-red-600 hover:text-red-700 hover:bg-red-50"
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </td>
                    </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>

        {/* User Details & Stats Dialog */}
        <Dialog open={showDetailsDialog} onOpenChange={(open) => {
          setShowDetailsDialog(open)
          if (!open) {
            setUserStats(null)
          }
        }}>
          <DialogContent className="max-w-3xl max-h-[90vh]">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Eye className="w-5 h-5" />
                User Statistics & Management
              </DialogTitle>
              <DialogDescription>
                {selectedUser?.email}
              </DialogDescription>
            </DialogHeader>
            {selectedUser && (
              <ScrollArea className="max-h-[70vh] pr-4">
                <div className="space-y-6">
                  {/* User Info Header */}
                  <div className="flex items-center justify-between p-4 bg-gradient-to-r from-emerald-50 to-teal-50 rounded-lg border border-emerald-200">
                    <div>
                      <p className="font-semibold text-lg">{selectedUser.email}</p>
                      <p className="text-sm text-gray-600">{selectedUser.phoneNumber || "No phone"}</p>
                      <p className="text-xs text-gray-500">Joined: {new Date(selectedUser.created_at).toLocaleDateString()}</p>
                    </div>
                    <Badge className={`${selectedUser.role === "admin" ? "bg-red-600" : "bg-blue-600"}`}>
                      {selectedUser.role.toUpperCase()}
                    </Badge>
                  </div>

                  {statsLoading ? (
                    <div className="flex items-center justify-center py-12">
                      <Loader2 className="w-8 h-8 animate-spin text-emerald-600" />
                      <span className="ml-2 text-gray-500">Loading statistics...</span>
                    </div>
                  ) : userStats ? (
                    <Tabs defaultValue="wallet" className="w-full">
                      <TabsList className="grid w-full grid-cols-4">
                        <TabsTrigger value="wallet" className="text-xs sm:text-sm">
                          <Wallet className="w-4 h-4 mr-1 hidden sm:inline" />
                          Wallet
                        </TabsTrigger>
                        <TabsTrigger value="orders" className="text-xs sm:text-sm">
                          <ShoppingCart className="w-4 h-4 mr-1 hidden sm:inline" />
                          Orders
                        </TabsTrigger>
                        <TabsTrigger value="shop" className="text-xs sm:text-sm">
                          <Store className="w-4 h-4 mr-1 hidden sm:inline" />
                          Shop
                        </TabsTrigger>
                        <TabsTrigger value="withdrawals" className="text-xs sm:text-sm">
                          <ArrowDownCircle className="w-4 h-4 mr-1 hidden sm:inline" />
                          Withdrawals
                        </TabsTrigger>
                      </TabsList>

                      {/* Wallet Stats */}
                      <TabsContent value="wallet" className="space-y-4 mt-4">
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                          <Card className="bg-blue-50 border-blue-200">
                            <CardContent className="p-4">
                              <p className="text-xs text-blue-600 font-medium">Current Balance</p>
                              <p className="text-xl font-bold text-blue-700">GHS {userStats.wallet.balance.toFixed(2)}</p>
                            </CardContent>
                          </Card>
                          <Card className="bg-green-50 border-green-200">
                            <CardContent className="p-4">
                              <p className="text-xs text-green-600 font-medium">Total Top-ups</p>
                              <p className="text-xl font-bold text-green-700">GHS {userStats.wallet.totalTopUps.toFixed(2)}</p>
                            </CardContent>
                          </Card>
                          <Card className="bg-orange-50 border-orange-200">
                            <CardContent className="p-4">
                              <p className="text-xs text-orange-600 font-medium">Total Spent</p>
                              <p className="text-xl font-bold text-orange-700">GHS {userStats.wallet.totalSpent.toFixed(2)}</p>
                            </CardContent>
                          </Card>
                          <Card className="bg-purple-50 border-purple-200">
                            <CardContent className="p-4">
                              <p className="text-xs text-purple-600 font-medium">Transactions</p>
                              <p className="text-xl font-bold text-purple-700">{userStats.wallet.transactionCount}</p>
                            </CardContent>
                          </Card>
                        </div>
                      </TabsContent>

                      {/* Orders Stats */}
                      <TabsContent value="orders" className="space-y-4 mt-4">
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                          <Card className="bg-blue-50 border-blue-200">
                            <CardContent className="p-4">
                              <p className="text-xs text-blue-600 font-medium">Total Orders</p>
                              <p className="text-xl font-bold text-blue-700">{userStats.orders.total}</p>
                            </CardContent>
                          </Card>
                          <Card className="bg-green-50 border-green-200">
                            <CardContent className="p-4">
                              <div className="flex items-center gap-1">
                                <CheckCircle className="w-3 h-3 text-green-600" />
                                <p className="text-xs text-green-600 font-medium">Completed</p>
                              </div>
                              <p className="text-xl font-bold text-green-700">{userStats.orders.completed}</p>
                            </CardContent>
                          </Card>
                          <Card className="bg-orange-50 border-orange-200">
                            <CardContent className="p-4">
                              <div className="flex items-center gap-1">
                                <Clock className="w-3 h-3 text-orange-600" />
                                <p className="text-xs text-orange-600 font-medium">Pending</p>
                              </div>
                              <p className="text-xl font-bold text-orange-700">{userStats.orders.pending}</p>
                            </CardContent>
                          </Card>
                          <Card className="bg-red-50 border-red-200">
                            <CardContent className="p-4">
                              <div className="flex items-center gap-1">
                                <XCircle className="w-3 h-3 text-red-600" />
                                <p className="text-xs text-red-600 font-medium">Failed</p>
                              </div>
                              <p className="text-xl font-bold text-red-700">{userStats.orders.failed}</p>
                            </CardContent>
                          </Card>
                        </div>
                      </TabsContent>

                      {/* Shop Stats */}
                      <TabsContent value="shop" className="space-y-4 mt-4">
                        {userStats.shop ? (
                          <>
                            <div className="p-3 bg-purple-50 rounded-lg border border-purple-200">
                              <p className="font-semibold text-purple-700">{userStats.shop.shopName}</p>
                              <p className="text-xs text-purple-600">/{userStats.shop.shopSlug}</p>
                              <p className="text-xs text-gray-500 mt-1">Created: {new Date(userStats.shop.createdAt).toLocaleDateString()}</p>
                              <p className="text-xs text-gray-400 mt-1">{userStats.shop.profitRecords} profit records</p>
                            </div>
                            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                              <Card className="bg-blue-50 border-blue-200">
                                <CardContent className="p-4">
                                  <p className="text-xs text-blue-600 font-medium">Shop Orders</p>
                                  <p className="text-xl font-bold text-blue-700">{userStats.shop.totalOrders}</p>
                                  <p className="text-xs text-gray-500">{userStats.shop.paidOrders} paid, {userStats.shop.completedOrders} fulfilled</p>
                                </CardContent>
                              </Card>
                              <Card className="bg-green-50 border-green-200">
                                <CardContent className="p-4">
                                  <p className="text-xs text-green-600 font-medium">Total Sales</p>
                                  <p className="text-xl font-bold text-green-700">GHS {userStats.shop.totalSales.toFixed(2)}</p>
                                </CardContent>
                              </Card>
                              <Card className="bg-emerald-50 border-emerald-200">
                                <CardContent className="p-4">
                                  <div className="flex items-center gap-1">
                                    <TrendingUp className="w-3 h-3 text-emerald-600" />
                                    <p className="text-xs text-emerald-600 font-medium">Total Profit</p>
                                  </div>
                                  <p className="text-xl font-bold text-emerald-700">GHS {userStats.shop.totalProfit.toFixed(2)}</p>
                                </CardContent>
                              </Card>
                              <Card className="bg-purple-50 border-purple-200">
                                <CardContent className="p-4">
                                  <p className="text-xs text-purple-600 font-medium">Available Balance</p>
                                  <p className="text-xl font-bold text-purple-700">GHS {userStats.shop.availableBalance.toFixed(2)}</p>
                                </CardContent>
                              </Card>
                              <Card className="bg-teal-50 border-teal-200">
                                <CardContent className="p-4">
                                  <p className="text-xs text-teal-600 font-medium">Credited Profit</p>
                                  <p className="text-xl font-bold text-teal-700">GHS {userStats.shop.creditedProfit.toFixed(2)}</p>
                                </CardContent>
                              </Card>
                              <Card className="bg-orange-50 border-orange-200">
                                <CardContent className="p-4">
                                  <p className="text-xs text-orange-600 font-medium">Pending Profit</p>
                                  <p className="text-xl font-bold text-orange-700">GHS {userStats.shop.pendingProfit.toFixed(2)}</p>
                                </CardContent>
                              </Card>
                              <Card className="bg-gray-50 border-gray-200">
                                <CardContent className="p-4">
                                  <p className="text-xs text-gray-600 font-medium">Total Withdrawn</p>
                                  <p className="text-xl font-bold text-gray-700">GHS {userStats.shop.withdrawnAmount.toFixed(2)}</p>
                                </CardContent>
                              </Card>
                            </div>
                          </>
                        ) : (
                          <div className="text-center py-8 text-gray-500">
                            <Store className="w-12 h-12 mx-auto mb-2 text-gray-300" />
                            <p>This user does not own a shop</p>
                          </div>
                        )}
                      </TabsContent>

                      {/* Withdrawals */}
                      <TabsContent value="withdrawals" className="space-y-4 mt-4">
                        {userStats.shop ? (
                          <>
                            <div className="grid grid-cols-3 gap-3">
                              <Card className="bg-green-50 border-green-200">
                                <CardContent className="p-4">
                                  <p className="text-xs text-green-600 font-medium">Total Withdrawn</p>
                                  <p className="text-xl font-bold text-green-700">GHS {userStats.withdrawals.totalWithdrawn.toFixed(2)}</p>
                                </CardContent>
                              </Card>
                              <Card className="bg-blue-50 border-blue-200">
                                <CardContent className="p-4">
                                  <p className="text-xs text-blue-600 font-medium">Completed</p>
                                  <p className="text-xl font-bold text-blue-700">{userStats.withdrawals.completedCount}</p>
                                </CardContent>
                              </Card>
                              <Card className="bg-orange-50 border-orange-200">
                                <CardContent className="p-4">
                                  <p className="text-xs text-orange-600 font-medium">Pending</p>
                                  <p className="text-xl font-bold text-orange-700">{userStats.withdrawals.pendingCount}</p>
                                </CardContent>
                              </Card>
                            </div>

                            {userStats.withdrawals.history.length > 0 ? (
                              <div className="border rounded-lg overflow-hidden">
                                <table className="w-full text-sm">
                                  <thead className="bg-gray-50">
                                    <tr>
                                      <th className="px-3 py-2 text-left font-medium">Date</th>
                                      <th className="px-3 py-2 text-left font-medium">Amount</th>
                                      <th className="px-3 py-2 text-left font-medium">Method</th>
                                      <th className="px-3 py-2 text-left font-medium">Status</th>
                                    </tr>
                                  </thead>
                                  <tbody className="divide-y">
                                    {userStats.withdrawals.history.slice(0, 10).map((w) => (
                                      <tr key={w.id} className="hover:bg-gray-50">
                                        <td className="px-3 py-2 text-xs">{new Date(w.createdAt).toLocaleDateString()}</td>
                                        <td className="px-3 py-2 font-medium">GHS {w.netAmount.toFixed(2)}</td>
                                        <td className="px-3 py-2 text-xs capitalize">{w.method.replace("_", " ")}</td>
                                        <td className="px-3 py-2">
                                          <Badge className={
                                            w.status === "completed" || w.status === "approved" ? "bg-green-600" :
                                            w.status === "pending" ? "bg-orange-500" :
                                            w.status === "rejected" ? "bg-red-600" : "bg-gray-500"
                                          }>
                                            {w.status}
                                          </Badge>
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            ) : (
                              <div className="text-center py-6 text-gray-500">
                                <p>No withdrawal history</p>
                              </div>
                            )}
                          </>
                        ) : (
                          <div className="text-center py-8 text-gray-500">
                            <ArrowDownCircle className="w-12 h-12 mx-auto mb-2 text-gray-300" />
                            <p>User does not own a shop</p>
                          </div>
                        )}
                      </TabsContent>
                    </Tabs>
                  ) : null}

                  {/* Actions Section */}
                  <div className="border-t pt-4 space-y-3">
                    <p className="text-sm font-semibold text-gray-700">Account Management</p>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div>
                        <Label htmlFor="role" className="text-xs">Change Role</Label>
                        <div className="flex gap-2 mt-1">
                          <select
                            id="role"
                            aria-label="Change user role"
                            value={newRole}
                            onChange={(e) => setNewRole(e.target.value)}
                            className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500 text-sm"
                          >
                            <option value="user">User</option>
                            <option value="admin">Admin</option>
                          </select>
                          <Button
                            onClick={handleUpdateRole}
                            size="sm"
                            className="bg-emerald-600 hover:bg-emerald-700"
                          >
                            Update
                          </Button>
                        </div>
                      </div>
                      <div className="flex items-end">
                        <Button
                          onClick={() => {
                            setNewPassword("")
                            setConfirmPassword("")
                            setShowChangePasswordDialog(true)
                          }}
                          variant="outline"
                          className="w-full"
                        >
                          Change Password
                        </Button>
                      </div>
                    </div>
                  </div>
                </div>
              </ScrollArea>
            )}
          </DialogContent>
        </Dialog>

        {/* Balance Management Dialog */}
        <Dialog open={showBalanceDialog} onOpenChange={setShowBalanceDialog}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>Manage User Balance</DialogTitle>
            </DialogHeader>
            {selectedUser && (
              <div className="space-y-4">
                <div>
                  <Label className="text-xs text-gray-600">User</Label>
                  <p className="font-semibold mt-1">{selectedUser.email}</p>
                </div>
                <div>
                  <Label className="text-xs text-gray-600">Current Balance</Label>
                  <p className="font-semibold mt-1 text-emerald-600">GHS {selectedUser.balance.toFixed(2)}</p>
                </div>
                <div>
                  <Label htmlFor="action" className="text-xs">Action</Label>
                  <select
                    id="action"
                    aria-label="Select balance action"
                    value={balanceAction}
                    onChange={(e) => setBalanceAction(e.target.value as "credit" | "debit")}
                    className="w-full mt-1 px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="credit">Credit (Add)</option>
                    <option value="debit">Debit (Subtract)</option>
                  </select>
                </div>
                <div>
                  <Label htmlFor="amount" className="text-xs">Amount (GHS)</Label>
                  <Input
                    id="amount"
                    type="number"
                    placeholder="0.00"
                    value={balanceAmount}
                    onChange={(e) => setBalanceAmount(e.target.value)}
                    className="mt-1"
                    step="0.01"
                  />
                </div>
                <Button
                  onClick={handleUpdateBalance}
                  className={`w-full ${balanceAction === "credit" ? "bg-gradient-to-r from-green-600 to-emerald-600 hover:from-green-700 hover:to-emerald-700" : "bg-gradient-to-r from-red-600 to-pink-600 hover:from-red-700 hover:to-pink-700"}`}
                >
                  {balanceAction === "credit" ? "Credit" : "Debit"} Amount
                </Button>
              </div>
            )}
          </DialogContent>
        </Dialog>

        {/* Change Password Dialog */}
        <Dialog open={showChangePasswordDialog} onOpenChange={setShowChangePasswordDialog}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>Change User Password</DialogTitle>
              <DialogDescription>
                Set a new password for {selectedUser?.email}
              </DialogDescription>
            </DialogHeader>
            {selectedUser && (
              <div className="space-y-4">
                <div>
                  <Label htmlFor="newPassword" className="text-xs">New Password</Label>
                  <Input
                    id="newPassword"
                    type="password"
                    placeholder="••••••••"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    disabled={isChangingPassword}
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label htmlFor="confirmPassword" className="text-xs">Confirm Password</Label>
                  <Input
                    id="confirmPassword"
                    type="password"
                    placeholder="••••••••"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    disabled={isChangingPassword}
                    className="mt-1"
                  />
                </div>
                <Button
                  onClick={handleChangePassword}
                  disabled={isChangingPassword}
                  className="w-full bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700"
                >
                  {isChangingPassword ? "Changing..." : "Change Password"}
                </Button>
              </div>
            )}
          </DialogContent>
        </Dialog>
      </div>
    </DashboardLayout>
  )
}
