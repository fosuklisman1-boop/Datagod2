"use client"

import { useState, useEffect } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { toast } from "sonner"
import { authService } from "@/lib/auth"
import { getAuthErrorMessage } from "@/lib/auth-errors"
import { supabase } from "@/lib/supabase"
import GuestPurchaseButton from "@/components/GuestPurchaseButton"
import GoogleAuthButton from "@/components/GoogleAuthButton"
import { useCommunityLink } from "@/hooks/use-community-link"
import { MessageCircle, Mail, Lock, Eye, EyeOff, Check } from "lucide-react"
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
  const [showPassword, setShowPassword] = useState(false)

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
    <div className="min-h-screen lg:grid lg:grid-cols-[1.05fr_1fr]">
      {/* Brand panel (desktop only) */}
      <div className="relative hidden lg:flex flex-col justify-between overflow-hidden bg-gradient-to-br from-primary to-violet-600 p-12 text-white">
        <div aria-hidden className="absolute -right-20 -top-16 h-72 w-72 rounded-full bg-white/10" />
        <div aria-hidden className="absolute -left-12 -bottom-12 h-48 w-48 rounded-full bg-white/10" />
        <Link href="/" className="relative flex items-center gap-3">
          <div className="rounded-xl bg-white/15 p-2">
            <img src="/favicon-v2.jpeg" alt="DATAGOD" className="h-7 w-7 rounded-lg object-cover" />
          </div>
          <span className="text-xl font-extrabold tracking-tight">DATAGOD</span>
        </Link>
        <div className="relative">
          <h2 className="mb-3 text-3xl font-extrabold tracking-tight">Welcome back.</h2>
          <p className="max-w-sm leading-relaxed text-white/90">
            Buy data &amp; airtime in seconds, run your own shop, and get paid — all in one place.
          </p>
          <ul className="mt-6 space-y-3 text-sm">
            {["Instant delivery on all networks", "Resell & earn with your own storefront", "Secure wallet & fast withdrawals"].map((t) => (
              <li key={t} className="flex items-center gap-3">
                <span className="grid h-5 w-5 place-items-center rounded-full bg-white/20">
                  <Check className="h-3 w-3" />
                </span>
                {t}
              </li>
            ))}
          </ul>
        </div>
        <p className="relative text-sm text-white/80">
          <span className="block text-2xl font-extrabold text-white">₵2M+</span> in bundles delivered to date
        </p>
      </div>

      {/* Form panel */}
      <div className="flex min-h-screen items-center justify-center bg-background px-6 py-10 sm:px-10 lg:min-h-0">
        <div className="w-full max-w-md">
          {/* Logo (mobile only) */}
          <div className="mb-8 flex items-center justify-center gap-2 lg:hidden">
            <div className="rounded-lg bg-card p-2 shadow-sm">
              <img src="/favicon-v2.jpeg" alt="DATAGOD" className="h-7 w-7 rounded-md object-cover" />
            </div>
            <span className="text-lg font-extrabold tracking-tight">DATAGOD</span>
          </div>

          <h1 className="text-2xl font-bold tracking-tight text-foreground">Sign in</h1>
          <p className="mt-1 mb-6 text-sm text-muted-foreground">Welcome back — please enter your details.</p>

          {/* Google first */}
          <GoogleAuthButton redirectTo={redirectTo} />

          <div className="relative my-5">
            <div className="absolute inset-0 flex items-center"><span className="w-full border-t border-border" /></div>
            <div className="relative flex justify-center text-xs">
              <span className="bg-background px-2 text-muted-foreground">or continue with email</span>
            </div>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <div className="relative">
                <Mail className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="email"
                  name="email"
                  type="email"
                  placeholder="you@example.com"
                  value={formData.email}
                  onChange={handleChange}
                  required
                  className="pl-9"
                />
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="password">Password</Label>
                <Link href="/auth/forgot-password" className="text-xs font-medium text-primary hover:underline">
                  Forgot password?
                </Link>
              </div>
              <div className="relative">
                <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="password"
                  name="password"
                  type={showPassword ? "text" : "password"}
                  placeholder="••••••••"
                  value={formData.password}
                  onChange={handleChange}
                  required
                  className="pl-9 pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  aria-label={showPassword ? "Hide password" : "Show password"}
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>

            <Button type="submit" className="w-full font-semibold" disabled={isLoading}>
              {isLoading ? "Signing in..." : "Sign in"}
            </Button>
          </form>

          <p className="mt-6 text-center text-sm text-muted-foreground">
            Don&apos;t have an account?{" "}
            <Link href="/auth/signup" className="font-medium text-primary hover:underline">Create an account</Link>
          </p>

          <div className="mt-4">
            <GuestPurchaseButton variant="secondary" className="w-full" />
          </div>

          {communityLoading ? (
            <Skeleton className="mt-3 h-10 w-full rounded-md" />
          ) : communityLink ? (
            <a href={communityLink} target="_blank" rel="noopener noreferrer" className="mt-3 block">
              <Button type="button" className="w-full gap-2 bg-green-600 hover:bg-green-700 text-white">
                <MessageCircle className="h-4 w-4" /> Join Community
              </Button>
            </a>
          ) : null}

          <div className="mt-6 text-center">
            <Link href="/" className="text-sm text-muted-foreground hover:underline">Back to Home</Link>
          </div>
        </div>
      </div>
    </div>
  )
}
