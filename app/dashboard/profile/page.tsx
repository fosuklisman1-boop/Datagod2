"use client"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { User, Mail, Phone, Briefcase, Key, LogOut, Loader2, CheckCircle2, ShieldAlert } from "lucide-react"
import { PhoneVerifyModal } from "@/components/phone-verify-modal"
import ApiKeysManager from "@/components/developer/ApiKeysManager"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { useAuth } from "@/hooks/use-auth"
import { supabase } from "@/lib/supabase"
import { toast } from "sonner"
import { authService } from "@/lib/auth"
import { useUserRole } from "@/hooks/use-user-role"

interface UserProfile {
  firstName: string
  lastName: string
  email: string
  phone?: string
  phoneVerified?: boolean
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
  const { isDealer } = useUserRole()
  const [profile, setProfile] = useState<UserProfile>({
    firstName: "",
    lastName: "",
    email: "",
    phone: "",
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
  // OAuth (Google) users have no password to verify — they set one via a phone OTP.
  const [isOAuthUser, setIsOAuthUser] = useState(false)
  const [showSetPasswordDialog, setShowSetPasswordDialog] = useState(false)
  const [setPwForm, setSetPwForm] = useState({ newPassword: "", confirmPassword: "" })
  const [setPwOtp, setSetPwOtp] = useState({ sent: false, code: "", verified: false })
  const [setPwLoading, setSetPwLoading] = useState(false)
  const [setPwOtpLoading, setSetPwOtpLoading] = useState(false)
  const [setPwVerifyLoading, setSetPwVerifyLoading] = useState(false)
  const [showEditProfileDialog, setShowEditProfileDialog] = useState(false)
  const [editForm, setEditForm] = useState({
    firstName: "",
    lastName: "",
    phone: "",
  })
  const [isSavingProfile, setIsSavingProfile] = useState(false)
  const [showPhoneVerifyModal, setShowPhoneVerifyModal] = useState(false)

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

      // Did this account sign up via Google? If so it has no password, so we offer
      // an OTP-confirmed "Set Password" instead of the current-password change flow.
      const providers = (user.app_metadata?.providers ?? []) as string[]
      setIsOAuthUser(user.app_metadata?.provider === "google" || providers.includes("google"))

      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) return

      // Get user email from auth
      const email = user.email || ""

      // Get user profile from users table
      const { data: profileData, error: profileError } = await supabase
        .from("users")
        .select("first_name, last_name, phone_number, phone_verified, created_at, role")
        .eq("id", user.id)
        .single()

      if (profileError) {
        console.warn("Profile fetch warning (this may be normal if users table is empty):", profileError.message)
      }

      let firstName = email.split("@")[0]
      let lastName = ""
      let phone = ""
      let phoneVerified = false
      let memberSince = new Date().toLocaleDateString()

      if (profileData) {
        firstName = profileData.first_name || firstName
        lastName = profileData.last_name || ""
        phone = profileData.phone_number || ""
        phoneVerified = profileData.phone_verified ?? false

        if (profileData.created_at) {
          memberSince = new Date(profileData.created_at).toLocaleDateString("en-US", {
            year: "numeric",
            month: "short",
            day: "numeric",
          })
        }
      }

      setProfile({
        firstName,
        lastName,
        email,
        phone,
        phoneVerified,
        role: profileData?.role || "user",
        status: "ACTIVE",
        memberSince,
      })

      // Initialize edit form with current values
      setEditForm({
        firstName,
        lastName,
        phone,
      })

      // No-phone gate is handled globally by DashboardLayout's PhoneRequiredModal
      // (shows on every dashboard page, including this one). The profile's own
      // phone dialog stays for the manual "add/change phone" button only.

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
      const errorMessage = error instanceof Error ? error.message : "Failed to load profile data"
      toast.error(errorMessage)
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

  // ── Google users: set a password, confirmed by a phone OTP ─────────────────
  const handleSendSetPwOtp = async () => {
    if (!profile.phone) {
      toast.error("Add and verify a phone number first")
      return
    }
    setSetPwOtpLoading(true)
    try {
      const res = await fetch("/api/auth/send-phone-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: profile.phone, purpose: "set_password" }),
      })
      const data = await res.json()
      if (!res.ok) { toast.error(data.error || "Failed to send code"); return }
      setSetPwOtp({ sent: true, code: "", verified: false })
      toast.success("Code sent to your phone.")
    } catch {
      toast.error("Failed to send code")
    } finally {
      setSetPwOtpLoading(false)
    }
  }

  const handleVerifySetPwOtp = async () => {
    if (setPwOtp.code.length !== 6) { toast.error("Enter the 6-digit code"); return }
    setSetPwVerifyLoading(true)
    try {
      const res = await fetch("/api/auth/verify-phone-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: profile.phone, code: setPwOtp.code, purpose: "set_password" }),
      })
      const data = await res.json()
      if (!res.ok || !data.verified) { toast.error(data.error || "Invalid or expired code"); return }
      setSetPwOtp((p) => ({ ...p, verified: true }))
      toast.success("Phone verified.")
    } catch {
      toast.error("Failed to verify code")
    } finally {
      setSetPwVerifyLoading(false)
    }
  }

  const resetSetPwDialog = () => {
    setSetPwForm({ newPassword: "", confirmPassword: "" })
    setSetPwOtp({ sent: false, code: "", verified: false })
  }

  const handleSetPassword = async () => {
    if (setPwForm.newPassword.length < 6) { toast.error("Password must be at least 6 characters"); return }
    if (setPwForm.newPassword !== setPwForm.confirmPassword) { toast.error("Passwords do not match"); return }
    if (!setPwOtp.verified) { toast.error("Verify the code sent to your phone first"); return }

    setSetPwLoading(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) { toast.error("Not authenticated"); return }

      const res = await fetch("/api/auth/set-password", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ newPassword: setPwForm.newPassword }),
      })
      const data = await res.json()
      if (!res.ok) { toast.error(data.error || "Failed to set password"); return }

      toast.success("Password set — you can now sign in with your email and password too.")
      setShowSetPasswordDialog(false)
      resetSetPwDialog()
    } catch {
      toast.error("An error occurred while setting your password")
    } finally {
      setSetPwLoading(false)
    }
  }

  const handleEditProfile = async () => {
    if (!editForm.firstName.trim()) {
      toast.error("First name is required")
      return
    }

    setIsSavingProfile(true)
    try {
      // Update via the service_role endpoint. A direct authenticated update
      // silently no-ops (0 rows, no error) when public.users' RLS UPDATE policy
      // is missing — the name "saves" then reverts on refresh. The endpoint
      // bypasses RLS and fails LOUD (42501 -> "run 0057") if service_role's GRANT
      // is missing. Phone is NOT edited here — it goes through the OTP flow.
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) {
        toast.error("Not authenticated")
        return
      }

      const res = await fetch("/api/user/update-profile", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ firstName: editForm.firstName, lastName: editForm.lastName }),
      })
      const data = await res.json()

      if (!res.ok) {
        console.error("Profile update error:", data)
        toast.error(data.error || "Failed to update profile")
        return
      }

      // Reflect the SERVER-CONFIRMED values, so the UI can't show a save that
      // didn't actually persist.
      setProfile((prev) => ({
        ...prev,
        firstName: data.firstName,
        lastName: data.lastName,
      }))

      toast.success("Profile updated successfully")
      setShowEditProfileDialog(false)
    } catch (error) {
      console.error("Error updating profile:", error)
      toast.error("An error occurred while updating profile")
    } finally {
      setIsSavingProfile(false)
    }
  }

  const handleOpenEditDialog = () => {
    // Reset form with current values
    setEditForm({
      firstName: profile.firstName,
      lastName: profile.lastName,
      phone: profile.phone || "",
    })
    setShowEditProfileDialog(true)
  }

  if (loading) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center min-h-screen">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      </DashboardLayout>
    )
  }

  return (
    <DashboardLayout>
      <div className="space-y-6">
        {/* Page Header */}
        <div>
          <h1 className="text-3xl font-bold text-foreground">My Profile</h1>
          <p className="text-muted-foreground mt-1">Manage your account information and settings</p>
        </div>

        {/* Profile Header Card */}
        <Card className={`border-0 text-white ${isDealer
            ? "bg-warning"
            : "bg-gradient-to-r from-primary to-primary"
          }`}>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-4">
                <div className="w-16 h-16 bg-card rounded-full flex items-center justify-center">
                  <User className={`w-8 h-8 ${isDealer ? "text-amber-600" : "text-primary"}`} />
                </div>
                <div>
                  <h2 className="text-2xl font-bold">{profile.firstName} {profile.lastName}</h2>
                  <p className={isDealer ? "text-amber-100" : "text-primary-foreground/80"}>{profile.email}</p>
                  <div className="flex gap-2 mt-2">
                    <Badge className={`bg-card ${isDealer ? "text-amber-600" : "text-primary"}`}>
                      {profile.role ? profile.role.toUpperCase() : "USER"}
                    </Badge>
                    <Badge className="bg-success">{profile.status}</Badge>
                  </div>
                </div>
              </div>
              <div className="flex gap-2">
                <Button
                  className={`bg-card hover:bg-accent ${isDealer ? "text-amber-600" : "text-primary"}`}
                  onClick={handleOpenEditDialog}
                >
                  Edit Profile
                </Button>
                <Button
                  variant="outline"
                  className="border-white text-white hover:bg-card/20"
                  onClick={() => (isOAuthUser ? setShowSetPasswordDialog(true) : setShowChangePasswordDialog(true))}
                >
                  {isOAuthUser ? "Set Password" : "Change Password"}
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
            <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-2">
              <div>
                <label className="text-sm font-medium text-foreground">First Name</label>
                <Input value={profile.firstName} readOnly className="mt-1" />
              </div>
              <div>
                <label className="text-sm font-medium text-foreground">Last Name</label>
                <Input value={profile.lastName} readOnly className="mt-1" />
              </div>
              <div>
                <label className="text-sm font-medium text-foreground">Email</label>
                <Input value={profile.email} readOnly className="mt-1" />
              </div>
              <div>
                <label className="text-sm font-medium text-foreground">Phone</label>
                <div className="flex items-center gap-2 mt-1">
                  <Input value={profile.phone || "Not provided"} readOnly className="flex-1" />
                  {!profile.phone ? (
                    <button
                      onClick={() => setShowPhoneVerifyModal(true)}
                      className="flex items-center gap-1 text-xs text-primary font-medium shrink-0 hover:text-primary"
                    >
                      <Phone className="w-4 h-4" /> Add
                    </button>
                  ) : profile.phoneVerified ? (
                    <>
                      <span className="flex items-center gap-1 text-xs text-success font-medium shrink-0">
                        <CheckCircle2 className="w-4 h-4" /> Verified
                      </span>
                      <button
                        onClick={() => setShowPhoneVerifyModal(true)}
                        className="text-xs text-primary font-medium shrink-0 hover:text-primary"
                      >
                        Change
                      </button>
                    </>
                  ) : (
                    <button
                      onClick={() => setShowPhoneVerifyModal(true)}
                      className="flex items-center gap-1 text-xs text-warning font-medium shrink-0 hover:text-warning"
                    >
                      <ShieldAlert className="w-4 h-4" /> Verify
                    </button>
                  )}
                </div>
              </div>
              <div>
                <label className="text-sm font-medium text-foreground">WhatsApp</label>
                <Input value={profile.phone || "Not provided"} readOnly className="mt-1" />
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
                <label className="text-sm font-medium text-foreground">Username</label>
                <Input value={profile.firstName.toLowerCase()} readOnly className="mt-1" />
              </div>
              <div>
                <label className="text-sm font-medium text-foreground">Role</label>
                <Input value={profile.role} readOnly className="mt-1" />
              </div>
              <div>
                <label className="text-sm font-medium text-foreground">Status</label>
                <div className="mt-1 flex items-center gap-2">
                  <Input value={profile.status} readOnly />
                  <Badge className="bg-success/15 text-success">Active</Badge>
                </div>
              </div>
              <div>
                <label className="text-sm font-medium text-foreground">Member Since</label>
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
            <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-2 lg:grid-cols-4">
              <div className="p-4 bg-primary/5 rounded-lg">
                <p className="text-sm text-muted-foreground">Total Orders</p>
                <p className="text-2xl font-bold text-primary">{stats.totalOrders.toLocaleString()}</p>
              </div>
              <div className="p-4 bg-success/10 rounded-lg">
                <p className="text-sm text-muted-foreground">Completed Orders</p>
                <p className="text-2xl font-bold text-success">{stats.completedOrders.toLocaleString()}</p>
              </div>
              <div className="p-4 bg-primary rounded-lg">
                <p className="text-sm text-muted-foreground">Success Rate</p>
                <p className="text-2xl font-bold text-primary">{stats.successRate.toFixed(1)}%</p>
              </div>
              <div className="p-4 bg-warning/10 rounded-lg">
                <p className="text-sm text-muted-foreground">Lifetime Spent</p>
                <p className="text-2xl font-bold text-warning">GHS {stats.totalSpent.toFixed(2)}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* API Keys */}
        {(isDealer || profile.role === 'admin') && (
          <Card>
            <CardContent className="pt-6">
              <ApiKeysManager />
            </CardContent>
          </Card>
        )}


        {/* Security */}
        <Card>
          <CardHeader>
            <CardTitle>Security</CardTitle>
            <CardDescription>Manage your account security</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between p-4 border rounded-lg">
              <div>
                <p className="font-semibold">Password</p>
                <p className="text-sm text-muted-foreground">
                  {isOAuthUser
                    ? "You signed up with Google. Set a password to also sign in with email."
                    : "Change the password you use to sign in."}
                </p>
              </div>
              <Button
                variant="outline"
                onClick={() => (isOAuthUser ? setShowSetPasswordDialog(true) : setShowChangePasswordDialog(true))}
              >
                <Key className="w-4 h-4 mr-2" />
                {isOAuthUser ? "Set Password" : "Change Password"}
              </Button>
            </div>
            <div className="flex items-center justify-between p-4 border rounded-lg">
              <div>
                <p className="font-semibold">Active Sessions</p>
                <p className="text-sm text-muted-foreground">You have 1 active session</p>
              </div>
              <Button variant="outline" className="text-destructive border-border hover:bg-destructive/10">
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
              <label className="text-sm font-medium text-foreground">Current Password</label>
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
              <label className="text-sm font-medium text-foreground">New Password</label>
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
              <label className="text-sm font-medium text-foreground">Confirm Password</label>
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
                className="bg-primary hover:bg-primary/90"
              >
                {isChangingPassword && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                {isChangingPassword ? "Changing..." : "Change Password"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Set Password Dialog (Google users — confirmed by phone OTP) */}
      <Dialog
        open={showSetPasswordDialog}
        onOpenChange={(o) => { setShowSetPasswordDialog(o); if (!o) resetSetPwDialog() }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Set a Password</DialogTitle>
            <DialogDescription>
              You signed up with Google. Verify the code we send to your phone
              {profile.phone ? ` (${profile.phone})` : ""}, then choose a password so you
              can also sign in with your email.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {/* OTP */}
            <div>
              <label className="text-sm font-medium text-foreground">Phone Verification</label>
              <div className="flex gap-2 mt-1">
                <Input
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  maxLength={6}
                  placeholder="6-digit code"
                  value={setPwOtp.code}
                  onChange={(e) => setSetPwOtp((p) => ({ ...p, code: e.target.value.replace(/\D/g, "").slice(0, 6) }))}
                  disabled={!setPwOtp.sent || setPwOtp.verified || setPwLoading}
                  className={setPwOtp.verified ? "border-green-500 focus-visible:ring-green-500" : ""}
                />
                {!setPwOtp.verified ? (
                  setPwOtp.sent ? (
                    <Button type="button" variant="outline" onClick={handleVerifySetPwOtp} disabled={setPwVerifyLoading || setPwOtp.code.length !== 6} className="shrink-0">
                      {setPwVerifyLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : "Verify"}
                    </Button>
                  ) : (
                    <Button type="button" variant="outline" onClick={handleSendSetPwOtp} disabled={setPwOtpLoading || !profile.phone} className="shrink-0">
                      {setPwOtpLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : "Send code"}
                    </Button>
                  )
                ) : (
                  <span className="inline-flex items-center text-green-600 text-sm px-2"><CheckCircle2 className="w-4 h-4 mr-1" /> Verified</span>
                )}
              </div>
              {setPwOtp.sent && !setPwOtp.verified && (
                <button type="button" onClick={handleSendSetPwOtp} disabled={setPwOtpLoading} className="text-xs text-primary hover:underline mt-1">
                  Resend code
                </button>
              )}
            </div>

            {/* New password */}
            <div>
              <label className="text-sm font-medium text-foreground">New Password</label>
              <Input
                type="password"
                placeholder="At least 6 characters"
                value={setPwForm.newPassword}
                onChange={(e) => setSetPwForm((p) => ({ ...p, newPassword: e.target.value }))}
                disabled={!setPwOtp.verified || setPwLoading}
                className="mt-1"
              />
            </div>
            <div>
              <label className="text-sm font-medium text-foreground">Confirm Password</label>
              <Input
                type="password"
                placeholder="Re-enter your new password"
                value={setPwForm.confirmPassword}
                onChange={(e) => setSetPwForm((p) => ({ ...p, confirmPassword: e.target.value }))}
                disabled={!setPwOtp.verified || setPwLoading}
                className="mt-1"
              />
            </div>

            <div className="flex gap-2 justify-end pt-4">
              <Button variant="outline" onClick={() => { setShowSetPasswordDialog(false); resetSetPwDialog() }} disabled={setPwLoading}>
                Cancel
              </Button>
              <Button
                onClick={handleSetPassword}
                disabled={setPwLoading || !setPwOtp.verified || !setPwForm.newPassword}
                className="bg-primary hover:bg-primary/90"
              >
                {setPwLoading && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                {setPwLoading ? "Saving..." : "Set Password"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Edit Profile Dialog */}
      <Dialog open={showEditProfileDialog} onOpenChange={setShowEditProfileDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Edit Profile</DialogTitle>
            <DialogDescription>
              Update your personal information
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium text-foreground">First Name</label>
              <Input
                type="text"
                placeholder="Enter your first name"
                value={editForm.firstName}
                onChange={(e) =>
                  setEditForm({
                    ...editForm,
                    firstName: e.target.value,
                  })
                }
                disabled={isSavingProfile}
                className="mt-1"
              />
            </div>
            <div>
              <label className="text-sm font-medium text-foreground">Last Name</label>
              <Input
                type="text"
                placeholder="Enter your last name"
                value={editForm.lastName}
                onChange={(e) =>
                  setEditForm({
                    ...editForm,
                    lastName: e.target.value,
                  })
                }
                disabled={isSavingProfile}
                className="mt-1"
              />
            </div>
            <p className="text-xs text-muted-foreground">
              To add or change your phone number, use the <span className="font-medium">Add/Change</span> option
              next to Phone on your profile — it's verified with a one-time code.
            </p>
            <div className="flex gap-2 justify-end pt-4">
              <Button
                variant="outline"
                onClick={() => setShowEditProfileDialog(false)}
                disabled={isSavingProfile}
              >
                Cancel
              </Button>
              <Button
                onClick={handleEditProfile}
                disabled={isSavingProfile}
                className="bg-primary hover:bg-primary/90"
              >
                {isSavingProfile && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                {isSavingProfile ? "Saving..." : "Save Changes"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <PhoneVerifyModal
        open={showPhoneVerifyModal}
        currentPhone={profile.phone || ""}
        dismissable
        onVerified={(newPhone) => {
          setShowPhoneVerifyModal(false)
          setProfile((p) => ({ ...p, phone: newPhone ?? p.phone, phoneVerified: true }))
        }}
        onDismiss={() => setShowPhoneVerifyModal(false)}
      />
    </DashboardLayout>
  )
}
