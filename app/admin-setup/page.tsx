"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { toast } from "sonner"
import { supabase } from "@/lib/supabase"
import { Shield } from "lucide-react"

export default function AdminSetupPage() {
  const router = useRouter()
  const [currentUser, setCurrentUser] = useState<any>(null)
  const [loading, setLoading] = useState(false)
  const [userEmail, setUserEmail] = useState("")

  useEffect(() => {
    loadCurrentUser()
  }, [])

  const loadCurrentUser = async () => {
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (user) {
        setCurrentUser(user)
        setUserEmail(user.email || "")
      }
    } catch (error) {
      console.error("Error loading user:", error)
    }
  }

  const makeCurrentUserAdmin = async () => {
    if (!currentUser) {
      toast.error("No user logged in")
      return
    }

    setLoading(true)
    try {
      const response = await fetch("/api/admin/set-admin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: currentUser.id }),
      })

      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.error || "Failed to set admin role")
      }

      toast.success("Admin role granted! Redirecting...")
      setTimeout(() => {
        router.push("/admin")
      }, 1000)
    } catch (error: any) {
      console.error("Error:", error)
      toast.error(error.message || "Failed to set admin role")
    } finally {
      setLoading(false)
    }
  }

  const makeUserAdmin = async (email: string) => {
    if (!email) {
      toast.error("Please enter an email")
      return
    }

    setLoading(true)
    try {
      const response = await fetch("/api/admin/set-admin-by-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      })

      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.error || "Failed to set admin role")
      }

      toast.success("Admin role granted to user!")
      setUserEmail("")
    } catch (error: any) {
      console.error("Error:", error)
      toast.error(error.message || "Failed to set admin role")
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-purple-900 to-slate-900 flex items-center justify-center p-4">
      <Card className="w-full max-w-md bg-slate-800 border-purple-500/50">
        <CardHeader>
          <div className="flex items-center gap-2 mb-2">
            <Shield className="w-6 h-6 text-purple-400" />
            <CardTitle className="text-white">Admin Setup</CardTitle>
          </div>
          <CardDescription className="text-slate-300">Grant admin access to users</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Current User Section */}
          {currentUser && (
            <div className="bg-slate-700/50 p-4 rounded-lg border border-slate-600">
              <p className="text-sm text-slate-300 mb-2">Your Account</p>
              <p className="text-white font-medium mb-4">{currentUser.email}</p>
              <Button
                onClick={makeCurrentUserAdmin}
                disabled={loading}
                className="w-full bg-gradient-to-r from-purple-600 to-purple-500 hover:from-purple-700 hover:to-purple-600 text-white"
              >
                {loading ? "Setting Admin..." : "Make Me Admin"}
              </Button>
            </div>
          )}

          {/* Separator */}
          <div className="relative">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-slate-600"></div>
            </div>
            <div className="relative flex justify-center text-xs uppercase">
              <span className="bg-slate-800 px-2 text-slate-400">Or</span>
            </div>
          </div>

          {/* Make Other User Admin */}
          <div className="space-y-3">
            <p className="text-sm text-slate-300">Grant admin to another user</p>
            <Input
              type="email"
              placeholder="User email"
              value={userEmail}
              onChange={(e) => setUserEmail(e.target.value)}
              className="bg-slate-700 border-slate-600 text-white placeholder-slate-400"
            />
            <Button
              onClick={() => makeUserAdmin(userEmail)}
              disabled={loading || !userEmail}
              className="w-full bg-gradient-to-r from-blue-600 to-blue-500 hover:from-blue-700 hover:to-blue-600 text-white"
            >
              {loading ? "Processing..." : "Grant Admin Access"}
            </Button>
          </div>

          {/* Info */}
          <div className="bg-slate-700/30 p-3 rounded text-xs text-slate-300">
            <p className="font-semibold mb-1">⚠️ Important</p>
            <p>This page should only be accessible to you. Keep it private!</p>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
