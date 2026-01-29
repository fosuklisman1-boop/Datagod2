"use client"

import { useState, useEffect } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { toast } from "sonner"
import { authService } from "@/lib/auth"
import { getAuthErrorMessage } from "@/lib/auth-errors"
import { supabase } from "@/lib/supabase"

export default function LoginForm() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [isLoading, setIsLoading] = useState(false)
  const [redirectTo, setRedirectTo] = useState("/dashboard")
  const [formData, setFormData] = useState({
    email: "",
    password: "",
  })

  // Get redirect URL from query params (default to /dashboard)
  useEffect(() => {
    const redirect = searchParams.get("redirect") || "/dashboard"
    setRedirectTo(redirect)
  }, [searchParams])

  // Handle form input changes
  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target
    setFormData((prev) => ({
      ...prev,
      [name]: value,
    }))
  }

  // Handle form submission
  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setIsLoading(true)

    try {
      if (!formData.email || !formData.password) {
        toast.error("Please fill in all fields")
        setIsLoading(false)
        return
      }

      await authService.login(formData.email, formData.password)
      toast.success("Login successful!")
      
      // Wait longer for session to be fully established
      await new Promise(resolve => setTimeout(resolve, 1000))
      
      // Check if user is a sub-agent (has parent_shop_id)
      try {
        const { data: { user } } = await supabase.auth.getUser()
        if (user) {
          const { data: userShop } = await supabase
            .from("user_shops")
            .select("id, parent_shop_id")
            .eq("user_id", user.id)
            .single()
          
          // If user is a sub-agent (has parent_shop_id), redirect to buy-stock page
          if (userShop?.parent_shop_id) {
            console.log("[LOGIN] Sub-agent detected, redirecting to buy-stock")
            window.location.href = "/dashboard/buy-stock"
            return
          }
        }
      } catch (shopError) {
        console.warn("[LOGIN] Could not check shop status:", shopError)
        // Continue with default redirect if check fails
      }
      
      // Redirect to the specified URL (from query params) or dashboard
      window.location.href = redirectTo
    } catch (error: any) {
      const { message } = getAuthErrorMessage(error)
      toast.error(message)
      console.error("Login error:", error)
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-violet-50 via-purple-50 to-fuchsia-50 p-4">
      <Card className="w-full max-w-md shadow-xl border border-white/40 bg-white/70 backdrop-blur-xl">
        <CardHeader className="space-y-2 text-center">
          <div className="flex justify-center mb-4">
            <div className="bg-white p-3 rounded-lg shadow-lg">
              <img src="/favicon-v2.jpeg" alt="DATAGOD Logo" className="w-8 h-8 rounded-lg object-cover" />
            </div>
          </div>
          <CardTitle className="text-3xl font-bold bg-gradient-to-r from-violet-600 via-purple-600 to-fuchsia-600 bg-clip-text text-transparent">Welcome Back</CardTitle>
          <CardDescription className="text-gray-600">Sign in to your DATAGOD account</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            {/* Email Field */}
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                name="email"
                type="email"
                placeholder="Enter your email"
                value={formData.email}
                onChange={handleChange}
                required
              />
            </div>

            {/* Password Field */}
            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                name="password"
                type="password"
                placeholder="Enter your password"
                value={formData.password}
                onChange={handleChange}
                required
              />
            </div>

            {/* Sign In Button */}
            <Button
              type="submit"
              className="w-full bg-gradient-to-r from-violet-600 via-purple-600 to-fuchsia-600 hover:from-violet-700 hover:via-purple-700 hover:to-fuchsia-700 shadow-lg hover:shadow-xl transition-all duration-300 text-white font-semibold"
              disabled={isLoading}
            >
              {isLoading ? "Signing in..." : "Sign In"}
            </Button>

            {/* Forgot Password Link */}
            <div className="text-center">
              <Link href="/auth/forgot-password" className="text-sm text-blue-600 hover:underline">
                Forgot your password?
              </Link>
            </div>

            {/* Create Account Link */}
            <div className="text-center text-sm text-gray-600">
              Don't have an account?{" "}
              <Link href="/auth/signup" className="text-blue-600 hover:underline font-medium">
                Create an account
              </Link>
            </div>

            {/* Back to Home Link */}
            <div className="text-center">
              <Link href="/" className="text-sm text-gray-600 hover:underline">
                Back to Home
              </Link>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
