"use client"

import { useState, useEffect, useRef } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { HomeAIChatWidget } from "@/components/home/AIChatWidget"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { ScrollArea } from "@/components/ui/scroll-area"
import { CheckCircle2, Loader2, Mail, Lock, Eye, EyeOff, Check } from "lucide-react"
import { toast } from "sonner"
import { authService } from "@/lib/auth"
import { getAuthErrorMessage } from "@/lib/auth-errors"
import GoogleAuthButton from "@/components/GoogleAuthButton"

const DEFAULT_TERMS = `Welcome to DATAGOD. By accessing or using our platform, you agree to be bound by these Terms of Service. Please read them carefully before creating an account or making any purchase.

1. General Account Registration & Security
By creating an account on DATAGOD, you agree to provide truthful and accurate personal information including your full name, phone number, and email address. You are solely responsible for maintaining the confidentiality of your password and for all activities that occur under your account. Your Wallet balance is tied exclusively to your account and may not be transferred to another user. DATAGOD reserves the right to suspend or terminate any account found to have provided false information or engaged in suspicious activity.

2. Instant, Non-Refundable Delivery
All digital products — including Mobile Data Bundles (MTN, Telecel, AT-iShare, AT-BigTime), Airtime, WAEC/School Results Checker Vouchers, and MTN AFA Registrations — are processed and delivered instantly upon successful payment or Wallet deduction. Once a transaction has been completed and the product delivered, it cannot be reversed, recalled, or refunded under any circumstances, except where explicitly covered under Section 4.

3. Buyer Accuracy Guarantee
You are solely responsible for verifying that the recipient's phone number and the selected telecommunications network (MTN, Telecel, AT-iShare, or AT-BigTime) are 100% correct before confirming any order. DATAGOD will not be held liable for deliveries made to an incorrect phone number or wrong network as a result of user input errors. No refund, credit, or replacement will be issued in such cases.

4. Processing Times & 24-Hour Reporting Window
While the vast majority of transactions are fulfilled within seconds, occasional delays may occur due to network downtime or high traffic. If you do not receive your order within a reasonable time, you MUST report it to our support team within 24 hours of purchase. Failure to report within this window may result in forfeiture of eligibility for fulfillment or manual compensation.

5. Payment Verification & Stay-on-Page Policy
When paying via our Paystack-powered checkout, you MUST remain on the payment page until you receive the final confirmation screen. Closing or navigating away from the payment tab before this confirmation may result in your payment being recorded but your order remaining unprocessed. DATAGOD is not liable for order failures caused by premature tab closure. If this occurs, use the order tracking feature or contact support immediately with your payment reference.

6. Wallet Top-Ups & Withdrawals
Wallet top-ups are processed via Paystack and are subject to applicable gateway and platform fees displayed at checkout. Funds added to your Wallet are non-transferable and may only be used for purchases on the DATAGOD platform. Withdrawal requests are subject to a processing fee and may take up to 3 business days to complete. DATAGOD reserves the right to pause wallet top-ups or withdrawals during scheduled maintenance.

7. Results Checker Vouchers
WAEC and School Results Checker Vouchers are strictly one-time-use digital products. Once a voucher has been delivered to you or used on any examination body's portal, it cannot be refunded, replaced, or reused. Ensure you use your voucher promptly and keep it secure. DATAGOD bears no responsibility for vouchers used or misplaced after delivery.

8. Agent, Dealer & Shop Roles
Users who subscribe to Agent or Dealer upgrade plans, or who operate Shops or Sub-Agent storefronts on the DATAGOD platform, are bound by the pricing guidelines, operational policies, and network provider rules set by DATAGOD. Sub-agents and shop owners must not set prices below the minimum floor prices defined by the platform. DATAGOD reserves the right to suspend, revoke, or downgrade any account found to be abusing the platform, violating network provider terms, or engaging in fraudulent activity.`

function parseTerms(content: string) {
  const lines = content.split("\n")
  let intro = ""
  const sections: Array<{ title: string; body: string }> = []
  let current: { title: string; lines: string[] } | null = null

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    if (/^\d+\.\s/.test(trimmed)) {
      if (current) sections.push({ title: current.title, body: current.lines.join(" ").trim() })
      current = { title: trimmed, lines: [] }
    } else if (current) {
      current.lines.push(trimmed)
    } else {
      intro += (intro ? " " : "") + trimmed
    }
  }
  if (current) sections.push({ title: current.title, body: current.lines.join(" ").trim() })
  return { intro, sections }
}

// Lightweight password strength: 0 = empty, 1 = weak, 2 = fair, 3 = strong.
// Purely cosmetic — the real minimum (6 chars) is still enforced on submit.
function passwordStrength(pw: string): number {
  if (!pw) return 0
  let score = 0
  if (pw.length >= 8) score++
  if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) score++
  if (/\d/.test(pw) || /[^A-Za-z0-9]/.test(pw)) score++
  return Math.min(score, 3)
}

export default function SignupPage() {
  const router = useRouter()
  const [isLoading, setIsLoading] = useState(false)
  const [formData, setFormData] = useState({
    firstName: "",
    lastName: "",
    phoneNumber: "",
    email: "",
    password: "",
    confirmPassword: "",
  })
  const [signupsEnabled, setSignupsEnabled] = useState<boolean | null>(null)
  const [showPassword, setShowPassword] = useState(false)
  const [showConfirm, setShowConfirm] = useState(false)

  // OTP state
  const [otpSent, setOtpSent] = useState(false)
  const [otpCode, setOtpCode] = useState("")
  const [phoneVerified, setPhoneVerified] = useState(false)
  const [otpLoading, setOtpLoading] = useState(false)
  const [verifyLoading, setVerifyLoading] = useState(false)
  const [resendTimer, setResendTimer] = useState(0)
  const resendTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Terms state
  const [termsAccepted, setTermsAccepted] = useState(false)
  const [termsModalOpen, setTermsModalOpen] = useState(false)
  const [termsContent, setTermsContent] = useState("")
  const [termsLastUpdated, setTermsLastUpdated] = useState<string | null>(null)
  const [loadingTerms, setLoadingTerms] = useState(false)

  // Fetch feature availability toggle
  useState(() => {
    const fetchSettings = async () => {
      try {
        const res = await fetch("/api/settings/public")
        if (res.ok) {
          const data = await res.json()
          setSignupsEnabled(data.signups_enabled)
        } else {
          setSignupsEnabled(true)
        }
      } catch (err) {
        setSignupsEnabled(true)
      }
    }
    fetchSettings()
  })

  const handleOpenTerms = async () => {
    setTermsModalOpen(true)
    if (termsContent) return
    setLoadingTerms(true)
    try {
      const res = await fetch("/api/public/terms")
      if (res.ok) {
        const data = await res.json()
        setTermsContent(data.terms_content || "")
        setTermsLastUpdated(data.terms_last_updated || null)
      }
    } catch {
      // fallback DEFAULT_TERMS shown via parseTerms
    } finally {
      setLoadingTerms(false)
    }
  }

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target
    setFormData((prev) => ({
      ...prev,
      [name]: value,
    }))
    // Reset phone verification when phone number changes
    if (name === "phoneNumber") {
      setOtpSent(false)
      setOtpCode("")
      setPhoneVerified(false)
    }
  }

  const startResendTimer = () => {
    setResendTimer(60)
    resendTimerRef.current = setInterval(() => {
      setResendTimer((t) => {
        if (t <= 1) {
          clearInterval(resendTimerRef.current!)
          return 0
        }
        return t - 1
      })
    }, 1000)
  }

  const handleSendOtp = async () => {
    const phoneDigits = formData.phoneNumber.replace(/\D/g, "")
    if (phoneDigits.length < 9 || phoneDigits.length > 10) {
      toast.error("Enter a valid phone number (9-10 digits) first")
      return
    }
    setOtpLoading(true)
    try {
      const res = await fetch("/api/auth/send-phone-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: formData.phoneNumber }),
      })
      const data = await res.json()
      if (!res.ok) {
        toast.error(data.error || "Failed to send OTP")
        return
      }
      setOtpSent(true)
      setPhoneVerified(false)
      setOtpCode("")
      startResendTimer()
      toast.success("OTP sent! Check your phone.")
    } catch {
      toast.error("Failed to send OTP")
    } finally {
      setOtpLoading(false)
    }
  }

  const handleVerifyOtp = async () => {
    if (!otpCode || otpCode.length !== 6) {
      toast.error("Enter the 6-digit OTP")
      return
    }
    setVerifyLoading(true)
    try {
      const res = await fetch("/api/auth/verify-phone-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: formData.phoneNumber, code: otpCode }),
      })
      const data = await res.json()
      if (!res.ok || !data.verified) {
        toast.error(data.error || "Invalid or expired code")
        return
      }
      setPhoneVerified(true)
      toast.success("Phone number verified!")
    } catch {
      toast.error("Failed to verify OTP")
    } finally {
      setVerifyLoading(false)
    }
  }

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setIsLoading(true)

    try {
      // Validate form
      if (!formData.firstName || !formData.lastName || !formData.phoneNumber || !formData.email || !formData.password) {
        toast.error("Please fill in all fields")
        setIsLoading(false)
        return
      }

      if (formData.password !== formData.confirmPassword) {
        toast.error("Passwords do not match")
        setIsLoading(false)
        return
      }

      if (formData.password.length < 6) {
        toast.error("Password must be at least 6 characters")
        setIsLoading(false)
        return
      }

      if (!termsAccepted) {
        toast.error("Please accept the Terms of Service to continue")
        setIsLoading(false)
        return
      }

      // Validate phone number (9-10 digits)
      const phoneDigits = formData.phoneNumber.replace(/\D/g, '')
      if (phoneDigits.length < 9 || phoneDigits.length > 10) {
        toast.error("Phone number must be 9 or 10 digits")
        setIsLoading(false)
        return
      }

      if (!phoneVerified) {
        toast.error("Please verify your phone number with the OTP first")
        setIsLoading(false)
        return
      }

      // Sign up with Supabase
      await authService.signUp(formData.email, formData.password, {
        first_name: formData.firstName,
        last_name: formData.lastName,
        phone_number: formData.phoneNumber,
      })

      toast.success("Account created! Please check your email to verify your account.")
      router.push("/auth/login")
    } catch (error: any) {
      const { message, type } = getAuthErrorMessage(error)

      if (type === 'user-exists') {
        toast.error(message)
        setTimeout(() => {
          router.push("/auth/login")
        }, 2000)
      } else {
        toast.error(message)
      }

      console.error("Signup error:", error)
    } finally {
      setIsLoading(false)
    }
  }

  const { intro, sections } = parseTerms(termsContent || DEFAULT_TERMS)
  const formattedDate = termsLastUpdated
    ? new Date(termsLastUpdated).toLocaleDateString("en-GB", { month: "long", year: "numeric" })
    : "April 2026"

  return (
    <>
      <div className="min-h-screen lg:grid lg:grid-cols-[1.05fr_1fr]">
        {/* Brand panel (desktop only) */}
        <div className="relative hidden lg:flex flex-col justify-between overflow-hidden bg-gradient-to-br from-primary to-primary p-12 text-white">
          <div aria-hidden className="absolute -right-20 -top-16 h-72 w-72 rounded-full bg-card/10" />
          <div aria-hidden className="absolute -left-12 -bottom-12 h-48 w-48 rounded-full bg-card/10" />
          <Link href="/" className="relative flex items-center gap-3">
            <div className="rounded-xl bg-card/15 p-2">
              <img src="/favicon-v2.jpeg" alt="DATAGOD" className="h-7 w-7 rounded-lg object-cover" />
            </div>
            <span className="text-xl font-extrabold tracking-tight">DATAGOD</span>
          </Link>
          <div className="relative">
            <h2 className="mb-3 text-3xl font-extrabold tracking-tight">Create your account.</h2>
            <p className="max-w-sm leading-relaxed text-white/90">Join thousands of resellers across Ghana.</p>
            <ul className="mt-6 space-y-3 text-sm">
              {["Free to create — no charges", "Instant wallet on signup", "Sell MTN, Telecel & AT bundles"].map((t) => (
                <li key={t} className="flex items-center gap-3">
                  <span className="grid h-5 w-5 place-items-center rounded-full bg-card/20">
                    <Check className="h-3 w-3" />
                  </span>
                  {t}
                </li>
              ))}
            </ul>
          </div>
          <p className="relative text-sm text-white/80">
            <span className="block text-2xl font-extrabold text-white">10,000+</span> agents trust DATAGOD
          </p>
        </div>

        {/* Form panel */}
        <div className="flex min-h-screen items-center justify-center bg-background px-6 py-10 sm:px-10 lg:min-h-0">
          <div className="w-full max-w-md">
            <div className="mb-8 flex items-center justify-center gap-2 lg:hidden">
              <div className="rounded-lg bg-card p-2 shadow-sm">
                <img src="/favicon-v2.jpeg" alt="DATAGOD" className="h-7 w-7 rounded-md object-cover" />
              </div>
              <span className="text-lg font-extrabold tracking-tight">DATAGOD</span>
            </div>
            <h1 className="text-2xl font-bold tracking-tight text-foreground">Create account</h1>
            <p className="mt-1 mb-6 text-sm text-muted-foreground">Start buying &amp; reselling in minutes.</p>

            {signupsEnabled === null ? (
              <div className="flex justify-center p-8">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
              </div>
            ) : signupsEnabled === false ? (
              <div className="text-center space-y-4 py-8">
                <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-red-100 mb-2">
                  <svg className="w-8 h-8 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>
                </div>
                <h3 className="text-xl font-bold text-foreground">Signups Temporarily Disabled</h3>
                <p className="text-muted-foreground max-w-sm mx-auto">
                  We are currently performing maintenance or upgrades. New account registrations are paused. Please try again later.
                </p>
                <div className="pt-4">
                  <Link href="/auth/login" className="text-primary hover:underline font-medium">
                    Return to Login
                  </Link>
                </div>
              </div>
            ) : (
              <form onSubmit={handleSubmit} className="space-y-4">
                {/* First Name */}
                <div className="space-y-2">
                  <Label htmlFor="firstName">First Name</Label>
                  <Input
                    id="firstName"
                    name="firstName"
                    type="text"
                    placeholder="Enter your first name"
                    value={formData.firstName}
                    onChange={handleChange}
                    required
                  />
                </div>

                {/* Last Name */}
                <div className="space-y-2">
                  <Label htmlFor="lastName">Last Name</Label>
                  <Input
                    id="lastName"
                    name="lastName"
                    type="text"
                    placeholder="Enter your last name"
                    value={formData.lastName}
                    onChange={handleChange}
                    required
                  />
                </div>

                {/* Phone Number + OTP */}
                <div className="space-y-2">
                  <Label htmlFor="phoneNumber">Phone Number</Label>
                  <div className="flex gap-2">
                    <div className="relative flex-1">
                      <Input
                        id="phoneNumber"
                        name="phoneNumber"
                        type="tel"
                        placeholder="Enter your phone number"
                        value={formData.phoneNumber}
                        onChange={handleChange}
                        required
                        className={phoneVerified ? "pr-8 border-green-500 focus-visible:ring-green-500" : ""}
                      />
                      {phoneVerified && (
                        <CheckCircle2 className="absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 text-green-500" />
                      )}
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={handleSendOtp}
                      disabled={otpLoading || resendTimer > 0 || phoneVerified}
                      className="shrink-0 text-xs px-3"
                    >
                      {otpLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : resendTimer > 0 ? `${resendTimer}s` : otpSent ? "Resend" : "Send OTP"}
                    </Button>
                  </div>

                  {otpSent && !phoneVerified && (
                    <>
                    <div className="flex gap-2 pt-1">
                      <Input
                        type="text"
                        inputMode="numeric"
                        pattern="[0-9]*"
                        maxLength={6}
                        placeholder="Enter 6-digit code"
                        value={otpCode}
                        onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                        className="flex-1"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        onClick={handleVerifyOtp}
                        disabled={verifyLoading || otpCode.length !== 6}
                        className="shrink-0 text-xs px-3"
                      >
                        {verifyLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : "Verify"}
                      </Button>
                    </div>
                    <p className="text-xs text-muted-foreground">📩 Don&apos;t see the code? Check your phone&apos;s Spam or Blocked messages folder.</p>
                    </>
                  )}
                </div>

                {/* Email */}
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

                {/* Password */}
                <div className="space-y-2">
                  <Label htmlFor="password">Password</Label>
                  <div className="relative">
                    <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      id="password"
                      name="password"
                      type={showPassword ? "text" : "password"}
                      placeholder="Create a password"
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
                  {formData.password && (
                    <>
                      <div className="flex gap-1.5">
                        {[0, 1, 2].map((i) => {
                          const s = passwordStrength(formData.password)
                          const color = s <= 1 ? "bg-destructive" : s === 2 ? "bg-warning" : "bg-success"
                          return <span key={i} className={`h-1 flex-1 rounded-full ${i < s ? color : "bg-border"}`} />
                        })}
                      </div>
                      <p className="text-[11px] text-muted-foreground">
                        {passwordStrength(formData.password) <= 1
                          ? "Weak — use 8+ characters with a mix."
                          : passwordStrength(formData.password) === 2
                            ? "Fair — add a number or symbol."
                            : "Strong password."}
                      </p>
                    </>
                  )}
                </div>

                {/* Confirm Password */}
                <div className="space-y-2">
                  <Label htmlFor="confirmPassword">Confirm Password</Label>
                  <div className="relative">
                    <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      id="confirmPassword"
                      name="confirmPassword"
                      type={showConfirm ? "text" : "password"}
                      placeholder="Confirm your password"
                      value={formData.confirmPassword}
                      onChange={handleChange}
                      required
                      className="pl-9 pr-10"
                    />
                    <button
                      type="button"
                      onClick={() => setShowConfirm((v) => !v)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                      aria-label={showConfirm ? "Hide password" : "Show password"}
                    >
                      {showConfirm ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                  {formData.confirmPassword && formData.confirmPassword !== formData.password && (
                    <p className="text-[11px] text-destructive">Passwords don&apos;t match.</p>
                  )}
                </div>

                {/* Terms of Service Checkbox */}
                <div className="flex items-start gap-3 pt-1">
                  <Checkbox
                    id="terms"
                    checked={termsAccepted}
                    onCheckedChange={(checked) => setTermsAccepted(checked === true)}
                    className="mt-0.5"
                  />
                  <label htmlFor="terms" className="text-sm text-muted-foreground leading-snug cursor-pointer select-none">
                    I have read and agree to the{" "}
                    <button
                      type="button"
                      onClick={handleOpenTerms}
                      className="text-primary hover:underline font-medium"
                    >
                      Terms of Service
                    </button>
                  </label>
                </div>

                {/* Sign Up Button */}
                <Button
                  type="submit"
                  className="w-full font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
                  disabled={isLoading || !termsAccepted || !phoneVerified}
                >
                  {isLoading ? "Creating account..." : "Create Account"}
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
                <GoogleAuthButton />

                {/* Login Link */}
                <div className="text-center text-sm text-muted-foreground">
                  Already have an account?{" "}
                  <Link href="/auth/login" className="text-primary hover:underline font-medium">
                    Sign in
                  </Link>
                </div>

                {/* Back to Home Link */}
                <div className="text-center">
                  <Link href="/" className="text-sm text-muted-foreground hover:underline">
                    Back to Home
                  </Link>
                </div>
              </form>
            )}
          </div>
        </div>
      </div>

      {/* Terms of Service Modal */}
      <Dialog open={termsModalOpen} onOpenChange={setTermsModalOpen}>
        <DialogContent className="max-w-lg flex flex-col" style={{ maxHeight: "80vh" }}>
          <DialogHeader>
            <DialogTitle className="text-lg font-bold">Terms of Service</DialogTitle>
          </DialogHeader>

          <ScrollArea className="flex-1 overflow-auto pr-2">
            {loadingTerms ? (
              <div className="flex justify-center py-10">
                <Loader2 className="w-6 h-6 animate-spin text-primary" />
              </div>
            ) : (
              <div className="space-y-4 text-sm py-2">
                {intro && (
                  <p className="text-muted-foreground leading-relaxed">{intro}</p>
                )}
                {sections.map((s, i) => (
                  <div key={i} className="p-3 bg-muted/40 rounded-lg border border-border">
                    <p className="font-bold text-foreground mb-1">{s.title}</p>
                    <p className="text-foreground leading-relaxed">{s.body}</p>
                  </div>
                ))}
                <p className="text-xs text-muted-foreground pt-2 text-center">
                  Last updated: {formattedDate}
                </p>
              </div>
            )}
          </ScrollArea>

          <DialogFooter className="pt-4 border-t mt-2 flex-shrink-0">
            <Button
              onClick={() => {
                setTermsAccepted(true)
                setTermsModalOpen(false)
              }}
              className="w-full font-semibold"
            >
              I Agree
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <HomeAIChatWidget />
    </>
  )
}
