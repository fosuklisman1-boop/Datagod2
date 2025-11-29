"use client"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { User, Mail, Phone, Briefcase, Key, LogOut, Loader2 } from "lucide-react"
import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { useAuth } from "@/hooks/use-auth"
import { supabase } from "@/lib/supabase"
import { toast } from "sonner"
import { authService } from "@/lib/auth"

interface UserProfile {
  firstName: string
  lastName: string
  email: string
  phone?: string
  businessName?: string
  role: string
  status: string
  memberSince: string
}

interface UserStats {
  totalOrders: number
  completedOrders: number
  successRate: number
  totalSpent: number
}

export default function ProfilePage() {
  const router = useRouter()
  const { user, loading: authLoading } = useAuth()
  const [profile, setProfile] = useState<UserProfile>({
    firstName: "",
    lastName: "",
    email: "",
    phone: "",
    businessName: "",
    role: "Agent",
    status: "ACTIVE",
    memberSince: "",
  })
  const [stats, setStats] = useState<UserStats>({
    totalOrders: 0,
    completedOrders: 0,
    successRate: 0,
    totalSpent: 0,
  })
  const [loading, setLoading] = useState(true)
  const [showChangePasswordDialog, setShowChangePasswordDialog] = useState(false)
  const [passwordForm, setPasswordForm] = useState({
    currentPassword: "",
    newPassword: "",
    confirmPassword: "",
  })
  const [isChangingPassword, setIsChangingPassword] = useState(false)

  // Auth protection
  useEffect(() => {
    if (!authLoading && !user) {
      console.log("[PROFILE] User not authenticated, redirecting to login")
      router.push("/auth/login")
    }
  }, [user, authLoading, router])

  useEffect(() => {
    if (user) {
      fetchUserProfile()
    }
  }, [user])

  const fetchUserProfile = async () => {
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return

      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) return

      // Get user data from auth
      const email = user.email || ""
      const firstName = user.user_metadata?.first_name || email.split("@")[0]
      const lastName = user.user_metadata?.last_name || ""
      const phone = user.user_metadata?.phone || ""
      const businessName = user.user_metadata?.business_name || ""

      // Get created date
      const createdAt = user.created_at
      let memberSince = new Date().toLocaleDateString()
      if (createdAt) {
        memberSince = new Date(createdAt).toLocaleDateString("en-US", {
          year: "numeric",
          month: "short",
          day: "numeric",
        })
      }

      setProfile({
        firstName,
        lastName,
        email,
        phone,
        businessName,
        role: "Agent",
        status: "ACTIVE",
        memberSince,
      })

      // Fetch user stats from dashboard stats
      const statsResponse = await fetch("/api/dashboard/stats", {
        headers: {
          Authorization: `Bearer ${session.access_token}`,
        },
      })
      if (statsResponse.ok) {
        const statsData = await statsResponse.json()
        if (statsData.stats) {
          setStats({
            totalOrders: statsData.stats.totalOrders || 0,
            completedOrders: statsData.stats.completed || 0,
            successRate: parseFloat(statsData.stats.successRate || "0"),
            totalSpent: 0, // Will need a separate endpoint for this
          })
        }
      }
    } catch (error) {
      console.error("Error fetching profile:", error)
      toast.error("Failed to load profile data")
    } finally {
      setLoading(false)
    }
  }

  const handleChangePassword = async () => {
    // Validation
    if (!passwordForm.currentPassword) {
      toast.error("Please enter your current password")
      return
    }

    if (!passwordForm.newPassword) {
      toast.error("Please enter a new password")
      return
    }

    if (passwordForm.newPassword.length < 6) {
      toast.error("New password must be at least 6 characters")
      return
    }

    if (passwordForm.newPassword !== passwordForm.confirmPassword) {
      toast.error("Passwords do not match")
      return
    }

    if (passwordForm.currentPassword === passwordForm.newPassword) {
      toast.error("New password must be different from current password")
      return
    }

    setIsChangingPassword(true)
    try {
      // First, verify the current password by trying to sign in
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email: profile.email,
        password: passwordForm.currentPassword,
      })

      if (signInError) {
        toast.error("Current password is incorrect")
        setIsChangingPassword(false)
        return
      }

      // Update the password
      const { error } = await supabase.auth.updateUser({
        password: passwordForm.newPassword,
      })

      if (error) {
        toast.error(error.message || "Failed to change password")
      } else {
        toast.success("Password changed successfully")
        setPasswordForm({
          currentPassword: "",
          newPassword: "",
          confirmPassword: "",
        })
        setShowChangePasswordDialog(false)
      }
    } catch (error) {
      console.error("Error changing password:", error)
      toast.error("An error occurred while changing password")
    } finally {
      setIsChangingPassword(false)
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
          <h1 className="text-3xl font-bold text-gray-900">My Profile</h1>
          <p className="text-gray-600 mt-1">Manage your account information and settings</p>
        </div>

        {/* Profile Header Card */}
        <Card className="bg-gradient-to-r from-blue-600 to-purple-600 text-white border-0">
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-4">
                <div className="w-16 h-16 bg-white rounded-full flex items-center justify-center">
                  <User className="w-8 h-8 text-blue-600" />
                </div>
                <div>
                  <h2 className="text-2xl font-bold">{profile.firstName} {profile.lastName}</h2>
                  <p className="text-blue-100">{profile.email}</p>
                  <div className="flex gap-2 mt-2">
                    <Badge className="bg-white text-blue-600">{profile.role}</Badge>
                    <Badge className="bg-green-500">{profile.status}</Badge>
                  </div>
                </div>
              </div>
              <div className="flex gap-2">
                <Button className="bg-white text-blue-600 hover:bg-gray-100">
                  Edit Profile
                </Button>
                <Button 
                  variant="outline" 
                  className="border-white text-white hover:bg-white/20"
                  onClick={() => setShowChangePasswordDialog(true)}
                >
                  Change Password
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Personal Information */}
        <Card>
          <CardHeader>
            <CardTitle>Personal Information</CardTitle>
            <CardDescription>Your personal details</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="text-sm font-medium text-gray-700">First Name</label>
                <Input value={profile.firstName} readOnly className="mt-1" />
              </div>
              <div>
                <label className="text-sm font-medium text-gray-700">Last Name</label>
                <Input value={profile.lastName} readOnly className="mt-1" />
              </div>
              <div>
                <label className="text-sm font-medium text-gray-700">Email</label>
                <Input value={profile.email} readOnly className="mt-1" />
              </div>
              <div>
                <label className="text-sm font-medium text-gray-700">Phone</label>
                <Input value={profile.phone || "Not provided"} readOnly className="mt-1" />
              </div>
              <div>
                <label className="text-sm font-medium text-gray-700">WhatsApp</label>
                <Input value={profile.phone || "Not provided"} readOnly className="mt-1" />
              </div>
              <div>
                <label className="text-sm font-medium text-gray-700">Business Name</label>
                <Input value={profile.businessName || "Not provided"} readOnly className="mt-1" />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Account Information */}
        <Card>
          <CardHeader>
            <CardTitle>Account Information</CardTitle>
            <CardDescription>Your account details and status</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="text-sm font-medium text-gray-700">Username</label>
                <Input value={profile.firstName.toLowerCase()} readOnly className="mt-1" />
              </div>
              <div>
                <label className="text-sm font-medium text-gray-700">Role</label>
                <Input value={profile.role} readOnly className="mt-1" />
              </div>
              <div>
                <label className="text-sm font-medium text-gray-700">Status</label>
                <div className="mt-1 flex items-center gap-2">
                  <Input value={profile.status} readOnly />
                  <Badge className="bg-green-100 text-green-800">Active</Badge>
                </div>
              </div>
              <div>
                <label className="text-sm font-medium text-gray-700">Member Since</label>
                <Input value={profile.memberSince} readOnly className="mt-1" />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Statistics */}
        <Card>
          <CardHeader>
            <CardTitle>Account Statistics</CardTitle>
            <CardDescription>Your performance metrics</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              <div className="p-4 bg-blue-50 rounded-lg">
                <p className="text-sm text-gray-600">Total Orders</p>
                <p className="text-2xl font-bold text-blue-600">{stats.totalOrders.toLocaleString()}</p>
              </div>
              <div className="p-4 bg-green-50 rounded-lg">
                <p className="text-sm text-gray-600">Completed Orders</p>
                <p className="text-2xl font-bold text-green-600">{stats.completedOrders.toLocaleString()}</p>
              </div>
              <div className="p-4 bg-purple-50 rounded-lg">
                <p className="text-sm text-gray-600">Success Rate</p>
                <p className="text-2xl font-bold text-purple-600">{stats.successRate.toFixed(1)}%</p>
              </div>
              <div className="p-4 bg-orange-50 rounded-lg">
                <p className="text-sm text-gray-600">Lifetime Spent</p>
                <p className="text-2xl font-bold text-orange-600">GHS {stats.totalSpent.toFixed(2)}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* API Keys */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <div>
              <CardTitle>API Keys</CardTitle>
              <CardDescription>Manage your API access</CardDescription>
            </div>
            <Button className="bg-gradient-to-r from-blue-600 to-purple-600">
              <Key className="w-4 h-4 mr-2" />
              Generate New Key
            </Button>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <div className="p-4 border rounded-lg">
                <div className="flex items-center justify-between mb-2">
                  <p className="font-semibold">API Key #18</p>
                  <Badge className="bg-red-100 text-red-800">Expired</Badge>
                </div>
                <div className="flex items-center gap-2 mb-3">
                  <Input value="••••••••••••••••••••" readOnly type="password" />
                  <Button size="sm" variant="outline">Copy</Button>
                </div>
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <p className="text-gray-600">Rate Limit</p>
                    <p className="font-semibold">100/min</p>
                  </div>
                  <div>
                    <p className="text-gray-600">Created</p>
                    <p className="font-semibold">Aug 11, 2025</p>
                  </div>
                  <div>
                    <p className="text-gray-600">Expires</p>
                    <p className="font-semibold">Nov 11, 2025</p>
                  </div>
                  <div>
                    <p className="text-gray-600">Webhook URL</p>
                    <p className="font-semibold text-xs">https://example.com/webhook</p>
                  </div>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Security */}
        <Card>
          <CardHeader>
            <CardTitle>Security</CardTitle>
            <CardDescription>Manage your account security</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between p-4 border rounded-lg">
              <div>
                <p className="font-semibold">Active Sessions</p>
                <p className="text-sm text-gray-600">You have 1 active session</p>
              </div>
              <Button variant="outline" className="text-red-600 border-red-200 hover:bg-red-50">
                <LogOut className="w-4 h-4 mr-2" />
                Logout All Devices
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Change Password Dialog */}
      <Dialog open={showChangePasswordDialog} onOpenChange={setShowChangePasswordDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Change Password</DialogTitle>
            <DialogDescription>
              Enter your current password and a new password
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium text-gray-700">Current Password</label>
              <Input
                type="password"
                placeholder="Enter your current password"
                value={passwordForm.currentPassword}
                onChange={(e) =>
                  setPasswordForm({
                    ...passwordForm,
                    currentPassword: e.target.value,
                  })
                }
                disabled={isChangingPassword}
                className="mt-1"
              />
            </div>
            <div>
              <label className="text-sm font-medium text-gray-700">New Password</label>
              <Input
                type="password"
                placeholder="Enter your new password"
                value={passwordForm.newPassword}
                onChange={(e) =>
                  setPasswordForm({
                    ...passwordForm,
                    newPassword: e.target.value,
                  })
                }
                disabled={isChangingPassword}
                className="mt-1"
              />
            </div>
            <div>
              <label className="text-sm font-medium text-gray-700">Confirm Password</label>
              <Input
                type="password"
                placeholder="Confirm your new password"
                value={passwordForm.confirmPassword}
                onChange={(e) =>
                  setPasswordForm({
                    ...passwordForm,
                    confirmPassword: e.target.value,
                  })
                }
                disabled={isChangingPassword}
                className="mt-1"
              />
            </div>
            <div className="flex gap-2 justify-end pt-4">
              <Button
                variant="outline"
                onClick={() => setShowChangePasswordDialog(false)}
                disabled={isChangingPassword}
              >
                Cancel
              </Button>
              <Button
                onClick={handleChangePassword}
                disabled={isChangingPassword}
                className="bg-blue-600 hover:bg-blue-700"
              >
                {isChangingPassword && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                {isChangingPassword ? "Changing..." : "Change Password"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  )
}
