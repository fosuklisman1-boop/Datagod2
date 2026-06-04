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
import GuestPurchaseButton from "@/components/GuestPurchaseButton"
import GoogleAuthButton from "@/components/GoogleAuthButton"
import { useCommunityLink } from "@/hooks/use-community-link"
import { MessageCircle } from "lucide-react"
import { Skeleton } from "@/components/ui/skeleton"

export default function LoginForm() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { communityLink, loading: communityLoading } = useCommunityLink()
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

      // Subscribe BEFORE login so we never miss the SIGNED_IN event.
      // Uses a 5s timeout as a safety net for very slow connections.
      const sessionReady = new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 5000)
        const { data: { subscription } } = supabase.auth.onAuthStateChange((event) => {
          if (event === "SIGNED_IN") {
            clearTimeout(timer)
            subscription.unsubscribe()
            resolve()
          }
        })
      })

      await authService.login(formData.email, formData.password)
      toast.success("Login successful!")

      // Wait for session to be fully established (event-driven, not a fixed delay)
      await sessionReady

      // router.push keeps the React app alive — in-memory session is already set,
      // no dependency on localStorage write completing before navigation.
      // Sub-agent redirect is handled by the dashboard page itself.
      router.push(redirectTo)
    } catch (error: any) {
      const { message } = getAuthErrorMessage(error)
      toast.error(message)
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-violet-50 via-purple-50 to-fuchsia-50 p-4">
      <Card className="w-full max-w-md shadow-xl border border-white/40 bg-card/70 backdrop-blur-xl">
        <CardHeader className="space-y-2 text-center">
          <div className="flex justify-center mb-4">
            <div className="bg-card p-3 rounded-lg shadow-lg">
              <img src="/favicon-v2.jpeg" alt="DATAGOD Logo" className="w-8 h-8 rounded-lg object-cover" />
            </div>
          </div>
          <CardTitle className="text-3xl font-bold bg-gradient-to-r from-violet-600 via-purple-600 to-fuchsia-600 bg-clip-text text-transparent">Welcome Back</CardTitle>
          <CardDescription className="text-muted-foreground">Sign in to your DATAGOD account</CardDescription>
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

            {/* Google OAuth */}
            <div className="relative my-1">
              <div className="absolute inset-0 flex items-center">
                <span className="w-full border-t border-border" />
              </div>
              <div className="relative flex justify-center text-xs uppercase">
                <span className="bg-card/70 px-2 text-muted-foreground">or</span>
              </div>
            </div>
            <GoogleAuthButton redirectTo={redirectTo} />

            {/* Forgot Password Link */}
            <div className="text-center">
              <Link href="/auth/forgot-password" className="text-sm text-primary hover:underline">
                Forgot your password?
              </Link>
            </div>

            {/* Create Account Link */}
            <div className="text-center text-sm text-muted-foreground">
              Don't have an account?{" "}
              <Link href="/auth/signup" className="text-primary hover:underline font-medium">
                Create an account
              </Link>
            </div>

            {/* Guest Purchase Button */}
            <div className="text-center">
              <GuestPurchaseButton variant="secondary" className="w-full mb-3" />
            </div>

            {/* Join Community */}
            {communityLoading ? (
              <Skeleton className="h-10 w-full rounded-md" />
            ) : communityLink ? (
              <a href={communityLink} target="_blank" rel="noopener noreferrer">
                <Button type="button" className="w-full gap-2 bg-green-600 hover:bg-green-700 text-white">
                  <MessageCircle className="w-4 h-4" />
                  Join Community
                </Button>
              </a>
            ) : null}

            {/* Back to Home Link */}
            <div className="text-center">
              <Link href="/" className="text-sm text-muted-foreground hover:underline">
                Back to Home
              </Link>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
