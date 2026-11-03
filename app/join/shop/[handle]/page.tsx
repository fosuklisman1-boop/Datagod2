"use client"

import { useEffect, useState } from "react"
import { useParams } from "next/navigation"
import Link from "next/link"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Loader2, Store, CheckCircle, AlertCircle, Eye, EyeOff, Mail } from "lucide-react"
import { toast } from "sonner"
import TurnstileWidget from "@/components/shop/TurnstileWidget"
import HoneypotField from "@/components/shop/HoneypotField"
import { supabase } from "@/lib/supabase"
import { useResendCooldown } from "@/lib/use-resend-cooldown"

interface WholesalePackage {
  network: string
  size: number
  wholesale_price: number
}

type PageState = "loading" | "closed" | "unavailable" | "open"

// Mirrors validateRecruitShopName in lib/sub-agents/join.ts (that file is server-only, so it can't be imported
// here). The server re-checks everything; this only gives a friendly message before the round trip.
function shopNameError(raw: string): string | null {
  const n = raw.replace(/\s+/g, " ").trim()
  if (n.length < 3 || n.length > 40) return "Shop name must be 3 to 40 characters."
  if (/:\/\//.test(n) || /www\./i.test(n) || /[A-Za-z0-9]\.[A-Za-z]{2,}/.test(n)) return "Shop name can't be a web address."
  if (/\d{7,}/.test(n)) return "Shop name can't contain a phone number."
  if (!/^[A-Za-z0-9 '&.\-]+$/.test(n)) return "Shop name can only use letters, numbers, spaces and ' & - ."
  return null
}

const NETWORK_COLORS: Record<string, string> = {
  MTN: "bg-yellow-100 text-yellow-800",
  Telecel: "bg-red-100 text-red-800",
  "AT - iShare": "bg-primary/10 text-primary",
  "AT - BigTime": "bg-primary/10 text-primary",
}

const OFFERS = [
  "Your own storefront to sell data",
  "Your own USSD code customers can dial",
  "Buy data at wholesale prices",
  "Set your own prices and keep the profit",
  "Withdraw earnings to your mobile money",
]

export default function JoinShopPage() {
  const params = useParams()
  const handle = params.handle as string

  const [state, setState] = useState<PageState>("loading")
  const [shopName, setShopName] = useState("")
  const [packages, setPackages] = useState<WholesalePackage[]>([])

  // Logged-in visitors get the short form.
  const [sessionToken, setSessionToken] = useState<string | null>(null)
  const [sessionEmail, setSessionEmail] = useState<string | null>(null)
  const [sessionChecked, setSessionChecked] = useState(false)

  const [form, setForm] = useState({ first_name: "", last_name: "", email: "", phone: "", password: "", my_shop_name: "" })
  const [showPassword, setShowPassword] = useState(false)
  const [honeypot, setHoneypot] = useState("")
  const [turnstileToken, setTurnstileToken] = useState("")
  const [turnstileEnabled, setTurnstileEnabled] = useState(true)
  const [turnstileKey, setTurnstileKey] = useState(0)

  const [otpSent, setOtpSent] = useState(false)
  const [otpCode, setOtpCode] = useState("")
  const [phoneVerified, setPhoneVerified] = useState(false)
  const [otpLoading, setOtpLoading] = useState(false)
  const [verifyLoading, setVerifyLoading] = useState(false)
  const cooldown = useResendCooldown(form.phone.replace(/\D/g, ""))

  const [submitting, setSubmitting] = useState(false)
  const [loginRequired, setLoginRequired] = useState(false)
  const [checkEmail, setCheckEmail] = useState(false)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch(`/api/shop/join/${encodeURIComponent(handle)}`, { cache: "no-store" })
        if (!res.ok) {
          if (!cancelled) setState("unavailable")
          return
        }
        const data = await res.json()
        if (cancelled) return
        if (data.status === "open") {
          setShopName(data.shop_name || "")
          setPackages(Array.isArray(data.wholesale_packages) ? data.wholesale_packages : [])
          setState("open")
        } else {
          setState("closed")
        }
      } catch {
        if (!cancelled) setState("unavailable")
      }
    })()
    return () => {
      cancelled = true
    }
  }, [handle])

  useEffect(() => {
    fetch("/api/public/turnstile-status")
      .then((r) => (r.ok ? r.json() : { enabled: true }))
      .then((d) => setTurnstileEnabled(d.enabled !== false))
      .catch(() => setTurnstileEnabled(true))
  }, [])

  useEffect(() => {
    ;(async () => {
      try {
        const { data } = await supabase.auth.getSession()
        setSessionToken(data.session?.access_token ?? null)
        setSessionEmail(data.session?.user?.email ?? null)
      } catch {
        /* treated as logged out */
      } finally {
        setSessionChecked(true)
      }
    })()
  }, [])

  const set = (name: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value
    setForm((f) => ({ ...f, [name]: value }))
    if (name === "phone") {
      setOtpSent(false)
      setOtpCode("")
      setPhoneVerified(false)
    }
  }

  const sendOtp = async () => {
    const digits = form.phone.replace(/\D/g, "")
    if (digits.length < 9 || digits.length > 10) {
      toast.error("Enter a valid phone number (9-10 digits) first")
      return
    }
    setOtpLoading(true)
    try {
      const res = await fetch("/api/auth/send-phone-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: form.phone, purpose: "signup" }),
      })
      const data = await res.json()
      if (!res.ok) {
        toast.error(data.error || "Failed to send code")
        return
      }
      setOtpSent(true)
      setPhoneVerified(false)
      setOtpCode("")
      cooldown.start(60)
      toast.success("Code sent! Check your phone.")
    } catch {
      toast.error("Failed to send code")
    } finally {
      setOtpLoading(false)
    }
  }

  const verifyOtp = async () => {
    if (otpCode.length !== 6) {
      toast.error("Enter the 6-digit code")
      return
    }
    setVerifyLoading(true)
    try {
      const res = await fetch("/api/auth/verify-phone-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: form.phone, code: otpCode, purpose: "signup" }),
      })
      const data = await res.json()
      if (!res.ok || !data.verified) {
        toast.error(data.error || "Invalid or expired code")
        return
      }
      setPhoneVerified(true)
      toast.success("Phone number verified!")
    } catch {
      toast.error("Failed to verify code")
    } finally {
      setVerifyLoading(false)
    }
  }

  const resetTurnstile = () => {
    setTurnstileToken("")
    setTurnstileKey((k) => k + 1)
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    const loggedIn = !!sessionToken

    const nameErr = shopNameError(form.my_shop_name)
    if (nameErr) {
      toast.error(nameErr)
      return
    }
    if (!loggedIn) {
      if (!form.first_name.trim() || !form.last_name.trim() || !form.email.trim() || !form.phone.trim() || !form.password) {
        toast.error("Please fill in every field")
        return
      }
      if (form.password.length < 6) {
        toast.error("Password must be at least 6 characters")
        return
      }
      if (!phoneVerified) {
        toast.error("Verify your phone number with the code we sent first")
        return
      }
    }

    setSubmitting(true)
    setLoginRequired(false)
    try {
      const body = loggedIn
        ? { shop_name: form.my_shop_name, turnstileToken, website: honeypot }
        : {
            first_name: form.first_name.trim(),
            last_name: form.last_name.trim(),
            email: form.email.trim(),
            phone: form.phone.trim(),
            password: form.password,
            shop_name: form.my_shop_name,
            turnstileToken,
            website: honeypot,
          }
      const res = await fetch(`/api/shop/join/${encodeURIComponent(handle)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(loggedIn ? { Authorization: `Bearer ${sessionToken}` } : {}) },
        body: JSON.stringify(body),
      })
      const data = await res.json().catch(() => ({}))

      if (!res.ok) {
        if (data.status === "closed") {
          setState("closed")
        } else if (data.status === "login_required") {
          setLoginRequired(true)
        }
        toast.error(data.error || "Something went wrong. Please try again.")
        resetTurnstile()
        return
      }

      if (data.status === "confirm_email") {
        setCheckEmail(true)
        return
      }
      if (data.status === "joined") {
        // The role changed, so refresh the session before landing on the setup page.
        try {
          await supabase.auth.refreshSession()
        } catch {
          /* the page still loads with the old session */
        }
        window.location.assign(typeof data.target === "string" && data.target.startsWith("/") ? data.target : "/dashboard")
        return
      }
      toast.error("Something went wrong. Please try again.")
      resetTurnstile()
    } catch {
      toast.error("Network error. Please try again.")
      resetTurnstile()
    } finally {
      setSubmitting(false)
    }
  }

  const loginHref = `/auth/login?redirect=${encodeURIComponent(`/join/shop/${handle}`)}`

  if (state === "loading" || !sessionChecked) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-card">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    )
  }

  if (state === "closed" || state === "unavailable") {
    const closed = state === "closed"
    return (
      <div className="min-h-screen flex items-center justify-center bg-card p-4">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <AlertCircle className="w-12 h-12 text-destructive mx-auto mb-4" />
            <CardTitle>{closed ? "This shop isn't taking sub-agents" : "Couldn't load this page"}</CardTitle>
            <CardDescription>
              {closed ? "It may be closed for now. You can still browse the shop or start your own." : "Please try again in a moment."}
            </CardDescription>
          </CardHeader>
          <CardContent className="text-center">
            <Link href="/">
              <Button variant="outline">Go to Homepage</Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    )
  }

  if (checkEmail) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-card p-4">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <Mail className="w-12 h-12 text-primary mx-auto mb-4" />
            <CardTitle>Check your email</CardTitle>
            <CardDescription>
              We sent a confirmation link to <span className="font-semibold text-foreground">{form.email.trim()}</span>. Click it
              to finish creating your account and open your shop under {shopName}.
            </CardDescription>
          </CardHeader>
          <CardContent className="text-center text-sm text-muted-foreground">
            Can&apos;t find it? Check your spam folder.
          </CardContent>
        </Card>
      </div>
    )
  }

  const loggedIn = !!sessionToken
  const tsBlocked = turnstileEnabled && !turnstileToken

  return (
    <div className="min-h-screen bg-card py-8 px-4 lg:py-14">
      <div className="mx-auto w-full max-w-2xl lg:max-w-6xl">
        <div className="text-center lg:text-left mb-6 lg:mb-10">
          <Store className="w-12 h-12 text-primary mx-auto lg:mx-0 mb-4" />
          <h1 className="text-3xl lg:text-4xl font-bold text-foreground">Join as a Sub-Agent</h1>
          <p className="text-muted-foreground mt-2">
            Start selling under <span className="font-semibold text-primary">{shopName}</span>
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-5 gap-6 lg:gap-8 items-start">
          {/* Offer and prices */}
          <div className="space-y-6 lg:col-span-3">
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">What you&apos;ll get</CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="space-y-2 text-sm">
                  {OFFERS.map((o) => (
                    <li key={o} className="flex items-center gap-2">
                      <CheckCircle className="w-4 h-4 text-success shrink-0" />
                      {o}
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>

            {packages.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-lg">Your Wholesale Prices</CardTitle>
                  <CardDescription>These are your costs. Set higher prices to make profit.</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                    {packages.slice(0, 9).map((pkg, idx) => (
                      <div key={idx} className="p-3 border rounded-lg text-center">
                        <Badge className={NETWORK_COLORS[pkg.network] || "bg-muted text-foreground"}>{pkg.network}</Badge>
                        <div className="font-semibold mt-1">{pkg.size}GB</div>
                        <div className="text-primary font-bold">GHS {(pkg.wholesale_price || 0).toFixed(2)}</div>
                      </div>
                    ))}
                  </div>
                  {packages.length > 9 && (
                    <p className="text-sm text-muted-foreground mt-2 text-center">+ {packages.length - 9} more packages</p>
                  )}
                </CardContent>
              </Card>
            )}
          </div>

          {/* Form */}
          <div className="lg:col-span-2 lg:sticky lg:top-6">
            <Card>
              <CardHeader>
                <CardTitle>{loggedIn ? "Welcome back" : "Create Your Account"}</CardTitle>
                <CardDescription>
                  {loggedIn
                    ? `Joining as ${sessionEmail ?? "your account"}. Just name your shop.`
                    : "Fill in your details to get started"}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <form onSubmit={submit} className="space-y-4">
                  {!loggedIn && (
                    <>
                      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2 gap-4">
                        <div className="space-y-2">
                          <Label htmlFor="first_name">First Name</Label>
                          <Input id="first_name" value={form.first_name} onChange={set("first_name")} placeholder="Kwame" maxLength={50} />
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="last_name">Last Name</Label>
                          <Input id="last_name" value={form.last_name} onChange={set("last_name")} placeholder="Mensah" maxLength={50} />
                        </div>
                      </div>

                      <div className="space-y-2">
                        <Label htmlFor="email">Email</Label>
                        <Input id="email" type="email" value={form.email} onChange={set("email")} placeholder="you@example.com" maxLength={254} />
                      </div>

                      <div className="space-y-2">
                        <Label htmlFor="password">Password</Label>
                        <div className="relative">
                          <Input
                            id="password"
                            type={showPassword ? "text" : "password"}
                            value={form.password}
                            onChange={set("password")}
                            placeholder="At least 6 characters"
                            maxLength={72}
                          />
                          <button
                            type="button"
                            aria-label={showPassword ? "Hide password" : "Show password"}
                            onClick={() => setShowPassword((s) => !s)}
                            className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground"
                          >
                            {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                          </button>
                        </div>
                      </div>

                      <div className="space-y-2">
                        <Label htmlFor="phone">Phone Number</Label>
                        <div className="flex gap-2">
                          <Input id="phone" type="tel" value={form.phone} onChange={set("phone")} placeholder="0241234567" disabled={phoneVerified} />
                          <Button
                            type="button"
                            variant="outline"
                            onClick={sendOtp}
                            disabled={otpLoading || phoneVerified || cooldown.seconds > 0}
                          >
                            {otpLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : cooldown.seconds > 0 ? `${cooldown.seconds}s` : otpSent ? "Resend" : "Send code"}
                          </Button>
                        </div>
                        {otpSent && !phoneVerified && (
                          <div className="flex gap-2">
                            <Input
                              inputMode="numeric"
                              value={otpCode}
                              onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                              placeholder="6-digit code"
                              aria-label="Phone verification code"
                            />
                            <Button type="button" onClick={verifyOtp} disabled={verifyLoading || otpCode.length !== 6}>
                              {verifyLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : "Verify"}
                            </Button>
                          </div>
                        )}
                        {phoneVerified && (
                          <p className="flex items-center gap-1 text-xs text-success">
                            <CheckCircle className="w-3.5 h-3.5" /> Phone number verified
                          </p>
                        )}
                      </div>

                      <hr />
                    </>
                  )}

                  <div className="space-y-2">
                    <Label htmlFor="my_shop_name">Your Shop Name</Label>
                    <Input
                      id="my_shop_name"
                      value={form.my_shop_name}
                      onChange={set("my_shop_name")}
                      placeholder="My Data Shop"
                      maxLength={40}
                    />
                    <p className="text-xs text-muted-foreground">3 to 40 characters. Letters, numbers, spaces and &apos; &amp; - .</p>
                  </div>

                  <HoneypotField value={honeypot} onChange={setHoneypot} />

                  {turnstileEnabled && (
                    <TurnstileWidget key={turnstileKey} onToken={setTurnstileToken} onExpire={() => setTurnstileToken("")} />
                  )}

                  {loginRequired && (
                    <p className="text-sm text-muted-foreground">
                      <Link href={loginHref} className="text-primary font-medium hover:underline">
                        Log in to continue
                      </Link>
                    </p>
                  )}

                  <Button
                    type="submit"
                    className="w-full font-semibold"
                    disabled={submitting || tsBlocked || (!loggedIn && !phoneVerified)}
                  >
                    {submitting ? (
                      <>
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        Joining...
                      </>
                    ) : loggedIn ? (
                      "Join as Sub-Agent"
                    ) : (
                      "Create Account & Join"
                    )}
                  </Button>
                </form>
              </CardContent>
            </Card>

            {!loggedIn && (
              <p className="text-center text-sm text-muted-foreground mt-4">
                Already have an account?{" "}
                <Link href={loginHref} className="text-primary hover:underline">
                  Log in
                </Link>
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
