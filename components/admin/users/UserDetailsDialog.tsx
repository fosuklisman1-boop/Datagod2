"use client"

import { useEffect, useState } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Eye, Loader2, Wallet, ShoppingCart, Store, ArrowDownCircle, TrendingUp, Clock, CheckCircle, XCircle } from "lucide-react"
import { toast } from "sonner"
import { adminUserService } from "@/lib/admin-service"
import { supabase } from "@/lib/supabase"
import type { AdminUser, UserStats } from "./types"

interface UserDetailsDialogProps {
  user: AdminUser | null
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called after the user was changed, so the list can reload. */
  onChanged: () => void
  onChangePassword: () => void
}

/** Details & stats, edit email/phone, change role, open change-password. */
export function UserDetailsDialog({ user, open, onOpenChange, onChanged, onChangePassword }: UserDetailsDialogProps) {
  const selectedUser = user
  const [userStats, setUserStats] = useState<UserStats | null>(null)
  const [statsLoading, setStatsLoading] = useState(false)
  const [newRole, setNewRole] = useState("")
  const [isUpdatingUser, setIsUpdatingUser] = useState(false)
  const [editEmail, setEditEmail] = useState("")
  const [editPhone, setEditPhone] = useState("")

  // Opening the dialog for a user: reset the form to that user and load their stats.
  useEffect(() => {
    if (!open || !user) return
    setEditEmail(user.email)
    setEditPhone(user.phoneNumber || "")
    setNewRole(user.role)
    loadUserStats(user.id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, user?.id])

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

  const handleUpdateUserDetails = async () => {
    if (!selectedUser) return
    if (!editEmail.trim()) {
      toast.error("Email is required")
      return
    }

    setIsUpdatingUser(true)
    try {
      await adminUserService.updateUserDetails(selectedUser.id, {
        email: editEmail,
        phoneNumber: editPhone
      })
      toast.success("User details updated successfully")
      onChanged()
      onOpenChange(false)
    } catch (error: any) {
      console.error("Error updating user details:", error)
      toast.error(error.message || "Failed to update user details")
    } finally {
      setIsUpdatingUser(false)
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
      onChanged()
      onOpenChange(false)
    } catch (error: any) {
      console.error("Error updating role:", error)
      toast.error(error.message || "Failed to update role")
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => {
      onOpenChange(o)
      if (!o) {
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
              {/* User Info Header with EDIT capability */}
              <div className="p-4 bg-card rounded-lg border border-white/60 dark:border-white/5 space-y-4 clay">
                <div className="flex items-center justify-between">
                  <div className="space-y-1 w-full max-w-[300px]">
                    <Label htmlFor="edit-email">Email Address</Label>
                    <Input
                      id="edit-email"
                      value={editEmail}
                      onChange={(e) => setEditEmail(e.target.value)}
                      className="bg-card"
                    />
                  </div>
                  <Badge className={`${selectedUser.role === "admin" ? "bg-destructive" : "bg-primary"}`}>
                    {selectedUser.role.toUpperCase()}
                  </Badge>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-1">
                    <Label htmlFor="edit-phone">Phone Number</Label>
                    <Input
                      id="edit-phone"
                      value={editPhone}
                      onChange={(e) => setEditPhone(e.target.value)}
                      className="bg-card"
                      placeholder="No phone number"
                    />
                  </div>
                  <div className="flex items-end">
                    <Button
                      onClick={handleUpdateUserDetails}
                      disabled={isUpdatingUser}
                      className="w-full bg-success hover:bg-success/90 gap-2"
                    >
                      {isUpdatingUser ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle className="w-4 h-4" />}
                      Update Email / Phone
                    </Button>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground italic">
                  Note: Changing the email will update both Supabase Auth and the database profile simultaneously.
                </p>
              </div>

              {statsLoading ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="w-8 h-8 animate-spin text-success" />
                  <span className="ml-2 text-muted-foreground">Loading statistics...</span>
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
                      <Card className="bg-primary/5 border-primary/20">
                        <CardContent className="p-4">
                          <p className="text-xs text-primary font-medium">Current Balance</p>
                          <p className="text-xl font-bold text-primary">GHS {Number(userStats.wallet.balance || 0).toFixed(2)}</p>
                        </CardContent>
                      </Card>
                      <Card className="bg-success/10 border-border">
                        <CardContent className="p-4">
                          <p className="text-xs text-success font-medium">Total Top-ups</p>
                          <p className="text-xl font-bold text-success">GHS {Number(userStats.wallet.totalTopUps || 0).toFixed(2)}</p>
                        </CardContent>
                      </Card>
                      <Card className="bg-warning/10 border-border">
                        <CardContent className="p-4">
                          <p className="text-xs text-warning font-medium">Total Spent</p>
                          <p className="text-xl font-bold text-warning">GHS {Number(userStats.wallet.totalSpent || 0).toFixed(2)}</p>
                        </CardContent>
                      </Card>
                      <Card className="bg-primary/10 border-border">
                        <CardContent className="p-4">
                          <p className="text-xs text-primary font-medium">Transactions</p>
                          <p className="text-xl font-bold text-primary">{userStats.wallet.transactionCount}</p>
                        </CardContent>
                      </Card>
                    </div>
                  </TabsContent>

                  {/* Orders Stats */}
                  <TabsContent value="orders" className="space-y-4 mt-4">
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                      <Card className="bg-primary/5 border-primary/20">
                        <CardContent className="p-4">
                          <p className="text-xs text-primary font-medium">Total Orders</p>
                          <p className="text-xl font-bold text-primary">{userStats.orders.total}</p>
                        </CardContent>
                      </Card>
                      <Card className="bg-success/10 border-border">
                        <CardContent className="p-4">
                          <div className="flex items-center gap-1">
                            <CheckCircle className="w-3 h-3 text-success" />
                            <p className="text-xs text-success font-medium">Completed</p>
                          </div>
                          <p className="text-xl font-bold text-success">{userStats.orders.completed}</p>
                        </CardContent>
                      </Card>
                      <Card className="bg-warning/10 border-border">
                        <CardContent className="p-4">
                          <div className="flex items-center gap-1">
                            <Clock className="w-3 h-3 text-warning" />
                            <p className="text-xs text-warning font-medium">Pending</p>
                          </div>
                          <p className="text-xl font-bold text-warning">{userStats.orders.pending}</p>
                        </CardContent>
                      </Card>
                      <Card className="bg-destructive/10 border-border">
                        <CardContent className="p-4">
                          <div className="flex items-center gap-1">
                            <XCircle className="w-3 h-3 text-destructive" />
                            <p className="text-xs text-destructive font-medium">Failed</p>
                          </div>
                          <p className="text-xl font-bold text-destructive">{userStats.orders.failed}</p>
                        </CardContent>
                      </Card>
                    </div>
                  </TabsContent>

                  {/* Shop Stats */}
                  <TabsContent value="shop" className="space-y-4 mt-4">
                    {userStats.shop ? (
                      <>
                        <div className="p-3 bg-primary/10 rounded-lg border border-border">
                          <p className="font-semibold text-primary">{userStats.shop.shopName}</p>
                          <p className="text-xs text-primary">/{userStats.shop.shopSlug}</p>
                          <p className="text-xs text-muted-foreground mt-1">Created: {new Date(userStats.shop.createdAt).toLocaleDateString()}</p>
                          <p className="text-xs text-muted-foreground mt-1">{userStats.shop.profitRecords} profit records</p>
                        </div>
                        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                          <Card className="bg-primary/5 border-primary/20">
                            <CardContent className="p-4">
                              <p className="text-xs text-primary font-medium">Shop Orders</p>
                              <p className="text-xl font-bold text-primary">{userStats.shop.totalOrders}</p>
                              <p className="text-xs text-muted-foreground">{userStats.shop.paidOrders} paid, {userStats.shop.completedOrders} fulfilled</p>
                            </CardContent>
                          </Card>
                          <Card className="bg-success/10 border-border">
                            <CardContent className="p-4">
                              <p className="text-xs text-success font-medium">Total Sales</p>
                              <p className="text-xl font-bold text-success">GHS {Number(userStats.shop.totalSales || 0).toFixed(2)}</p>
                            </CardContent>
                          </Card>
                          <Card className="bg-success/10 border-border">
                            <CardContent className="p-4">
                              <div className="flex items-center gap-1">
                                <TrendingUp className="w-3 h-3 text-success" />
                                <p className="text-xs text-success font-medium">Total Profit</p>
                              </div>
                              <p className="text-xl font-bold text-success">GHS {Number(userStats.shop.totalProfit || 0).toFixed(2)}</p>
                            </CardContent>
                          </Card>
                          <Card className="bg-primary/10 border-border">
                            <CardContent className="p-4">
                              <p className="text-xs text-primary font-medium">Available Balance</p>
                              <p className="text-xl font-bold text-primary">GHS {Number(userStats.shop.availableBalance || 0).toFixed(2)}</p>
                            </CardContent>
                          </Card>
                          <Card className="bg-success/10 border-border">
                            <CardContent className="p-4">
                              <p className="text-xs text-success font-medium">Credited Profit</p>
                              <p className="text-xl font-bold text-success">GHS {Number(userStats.shop.creditedProfit || 0).toFixed(2)}</p>
                            </CardContent>
                          </Card>
                          <Card className="bg-warning/10 border-border">
                            <CardContent className="p-4">
                              <p className="text-xs text-warning font-medium">Pending Profit</p>
                              <p className="text-xl font-bold text-warning">GHS {Number(userStats.shop.pendingProfit || 0).toFixed(2)}</p>
                            </CardContent>
                          </Card>
                          <Card className="bg-muted/40 border-border">
                            <CardContent className="p-4">
                              <p className="text-xs text-muted-foreground font-medium">Total Withdrawn</p>
                              <p className="text-xl font-bold text-foreground">GHS {Number(userStats.shop.withdrawnAmount || 0).toFixed(2)}</p>
                            </CardContent>
                          </Card>
                        </div>
                      </>
                    ) : (
                      <div className="text-center py-8 text-muted-foreground">
                        <Store className="w-12 h-12 mx-auto mb-2 text-muted-foreground" />
                        <p>This user does not own a shop</p>
                      </div>
                    )}
                  </TabsContent>

                  {/* Withdrawals */}
                  <TabsContent value="withdrawals" className="space-y-4 mt-4">
                    {userStats.shop ? (
                      <>
                        <div className="grid grid-cols-3 gap-3">
                          <Card className="bg-success/10 border-border">
                            <CardContent className="p-4">
                              <p className="text-xs text-success font-medium">Total Withdrawn</p>
                              <p className="text-xl font-bold text-success">GHS {Number(userStats.withdrawals.totalWithdrawn || 0).toFixed(2)}</p>
                            </CardContent>
                          </Card>
                          <Card className="bg-primary/5 border-primary/20">
                            <CardContent className="p-4">
                              <p className="text-xs text-primary font-medium">Completed</p>
                              <p className="text-xl font-bold text-primary">{userStats.withdrawals.completedCount}</p>
                            </CardContent>
                          </Card>
                          <Card className="bg-warning/10 border-border">
                            <CardContent className="p-4">
                              <p className="text-xs text-warning font-medium">Pending</p>
                              <p className="text-xl font-bold text-warning">{userStats.withdrawals.pendingCount}</p>
                            </CardContent>
                          </Card>
                        </div>

                        {userStats.withdrawals.history.length > 0 ? (
                          <div className="border rounded-lg overflow-hidden">
                            <table className="w-full text-sm">
                              <thead className="bg-muted/40">
                                <tr>
                                  <th className="px-3 py-2 text-left font-medium">Date</th>
                                  <th className="px-3 py-2 text-left font-medium">Amount</th>
                                  <th className="px-3 py-2 text-left font-medium">Method</th>
                                  <th className="px-3 py-2 text-left font-medium">Status</th>
                                </tr>
                              </thead>
                              <tbody className="divide-y">
                                {userStats.withdrawals.history.slice(0, 10).map((w) => (
                                  <tr key={w.id} className="hover:bg-accent">
                                    <td className="px-3 py-2 text-xs">{new Date(w.createdAt).toLocaleDateString()}</td>
                                    <td className="px-3 py-2 font-medium">GHS {Number(w.netAmount || 0).toFixed(2)}</td>
                                    <td className="px-3 py-2 text-xs capitalize">{w.method.replace("_", " ")}</td>
                                    <td className="px-3 py-2">
                                      <Badge className={
                                        w.status === "completed" || w.status === "approved" ? "bg-success" :
                                          w.status === "pending" ? "bg-warning" :
                                            w.status === "rejected" ? "bg-destructive" : "bg-muted-foreground"
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
                          <div className="text-center py-6 text-muted-foreground">
                            <p>No withdrawal history</p>
                          </div>
                        )}
                      </>
                    ) : (
                      <div className="text-center py-8 text-muted-foreground">
                        <ArrowDownCircle className="w-12 h-12 mx-auto mb-2 text-muted-foreground" />
                        <p>User does not own a shop</p>
                      </div>
                    )}
                  </TabsContent>
                </Tabs>
              ) : null}

              {/* Actions Section */}
              <div className="border-t pt-4 space-y-3">
                <p className="text-sm font-semibold text-foreground">Account Management</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <Label htmlFor="role" className="text-xs">Change Role</Label>
                    <div className="flex gap-2 mt-1">
                      <select
                        id="role"
                        aria-label="Change user role"
                        value={newRole}
                        onChange={(e) => setNewRole(e.target.value)}
                        className="flex-1 px-3 py-2 border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-success/30 text-sm"
                      >
                        <option value="user">User</option>
                        <option value="dealer">Dealer</option>
                        <option value="admin">Admin</option>
                      </select>
                      <Button
                        onClick={handleUpdateRole}
                        size="sm"
                        className="bg-success hover:bg-success/90"
                      >
                        Update
                      </Button>
                    </div>
                  </div>
                  <div className="flex items-end">
                    <Button
                      onClick={onChangePassword}
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
  )
}
