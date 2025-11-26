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
import { Trash2, Eye, Shield } from "lucide-react"
import { adminUserService } from "@/lib/admin-service"
import { supabase } from "@/lib/supabase"
import { toast } from "sonner"

interface User {
  id: string
  email: string
  created_at: string
  role: string
  balance: number
  shop?: any
}

export default function AdminUsersPage() {
  const router = useRouter()
  const [users, setUsers] = useState<User[]>([])
  const [loading, setLoading] = useState(true)
  const [isAdmin, setIsAdmin] = useState(false)
  const [selectedUser, setSelectedUser] = useState<User | null>(null)
  const [showDetailsDialog, setShowDetailsDialog] = useState(false)
  const [showBalanceDialog, setShowBalanceDialog] = useState(false)
  const [balanceAction, setBalanceAction] = useState<"credit" | "debit">("credit")
  const [balanceAmount, setBalanceAmount] = useState("")
  const [newRole, setNewRole] = useState("")

  useEffect(() => {
    checkAdminAccess()
  }, [])

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
      toast.error("Failed to load users")
    } finally {
      setLoading(false)
    }
  }

  const handleUpdateRole = async () => {
    if (!selectedUser || !newRole) {
      toast.error("Please select a role")
      return
    }

    try {
      await adminUserService.updateUserRole(selectedUser.id, newRole)
      toast.success("User role updated successfully")
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

  if (!isAdmin) return null

  return (
    <DashboardLayout>
      <div className="space-y-6">
        {/* Header */}
        <div>
          <h1 className="text-4xl font-bold bg-gradient-to-r from-emerald-600 to-teal-600 bg-clip-text text-transparent">User Management</h1>
          <p className="text-gray-500 mt-1">Manage user roles, balances, and account status</p>
        </div>

        {/* Users Table */}
        <Card className="bg-gradient-to-br from-emerald-50/60 to-teal-50/40 backdrop-blur-xl border border-emerald-200/40">
          <CardHeader>
            <CardTitle>All Users ({users.length})</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-gradient-to-r from-emerald-100/60 to-teal-100/60 backdrop-blur border-b border-emerald-200/40">
                  <tr>
                    <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">Email</th>
                    <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">Role</th>
                    <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">Balance</th>
                    <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">Shop</th>
                    <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">Joined</th>
                    <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-emerald-100/40">
                  {users.map((user) => (
                    <tr key={user.id} className="hover:bg-emerald-100/30 backdrop-blur transition-colors">
                      <td className="px-6 py-4 font-medium text-gray-900">{user.email}</td>
                      <td className="px-6 py-4">
                        <Badge className={user.role === "admin" ? "bg-red-600" : "bg-blue-600"}>
                          {user.role}
                        </Badge>
                      </td>
                      <td className="px-6 py-4 font-semibold text-emerald-600">GHS {user.balance.toFixed(2)}</td>
                      <td className="px-6 py-4 text-sm text-gray-600">{user.shop?.shop_name || "No shop"}</td>
                      <td className="px-6 py-4 text-sm text-gray-600">{new Date(user.created_at).toLocaleDateString()}</td>
                      <td className="px-6 py-4 flex gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setSelectedUser(user)
                            setNewRole(user.role)
                            setShowDetailsDialog(true)
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
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>

        {/* User Details Dialog */}
        <Dialog open={showDetailsDialog} onOpenChange={setShowDetailsDialog}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>User Details & Role Management</DialogTitle>
            </DialogHeader>
            {selectedUser && (
              <div className="space-y-4">
                <div>
                  <Label className="text-xs text-gray-600">Email</Label>
                  <p className="font-semibold mt-1">{selectedUser.email}</p>
                </div>
                <div>
                  <Label className="text-xs text-gray-600">Current Role</Label>
                  <Badge className={`${selectedUser.role === "admin" ? "bg-red-600" : "bg-blue-600"} mt-1`}>
                    {selectedUser.role}
                  </Badge>
                </div>
                <div>
                  <Label className="text-xs text-gray-600">Balance</Label>
                  <p className="font-semibold mt-1 text-emerald-600">GHS {selectedUser.balance.toFixed(2)}</p>
                </div>
                <div>
                  <Label htmlFor="role" className="text-xs">Change Role</Label>
                  <select
                    id="role"
                    aria-label="Change user role"
                    value={newRole}
                    onChange={(e) => setNewRole(e.target.value)}
                    className="w-full mt-1 px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  >
                    <option value="user">User</option>
                    <option value="admin">Admin</option>
                  </select>
                </div>
                <Button
                  onClick={handleUpdateRole}
                  className="w-full bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700"
                >
                  Update Role
                </Button>
              </div>
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
      </div>
    </DashboardLayout>
  )
}
