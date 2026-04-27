"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"
import { authService } from "@/lib/auth"
import { getAuthErrorMessage } from "@/lib/auth-errors"

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
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-emerald-50 via-teal-50 to-cyan-50 p-4">
        <Card className="w-full max-w-md shadow-xl border border-white/40 bg-white/70 backdrop-blur-xl">
          <CardHeader className="space-y-2 text-center">
            <div className="flex justify-center mb-4">
              <div className="bg-white p-3 rounded-lg shadow-lg">
                <img src="/favicon-v2.jpeg" alt="DATAGOD Logo" className="w-8 h-8 rounded-lg object-cover" />
              </div>
            </div>
            <CardTitle className="text-3xl font-bold bg-gradient-to-r from-emerald-600 via-teal-600 to-cyan-600 bg-clip-text text-transparent">Create Account</CardTitle>
            <CardDescription className="text-gray-600">Join DATAGOD today</CardDescription>
          </CardHeader>
          <CardContent>
            {signupsEnabled === null ? (
              <div className="flex justify-center p-8">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-emerald-600"></div>
              </div>
            ) : signupsEnabled === false ? (
              <div className="text-center space-y-4 py-8">
                <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-red-100 mb-2">
                  <svg className="w-8 h-8 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>
                </div>
                <h3 className="text-xl font-bold text-gray-900">Signups Temporarily Disabled</h3>
                <p className="text-gray-600 max-w-sm mx-auto">
                  We are currently performing maintenance or upgrades. New account registrations are paused. Please try again later.
                </p>
                <div className="pt-4">
                  <Link href="/auth/login" className="text-blue-600 hover:underline font-medium">
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

                {/* Phone Number */}
                <div className="space-y-2">
                  <Label htmlFor="phoneNumber">Phone Number</Label>
                  <Input
                    id="phoneNumber"
                    name="phoneNumber"
                    type="tel"
                    placeholder="Enter your phone number"
                    value={formData.phoneNumber}
                    onChange={handleChange}
                    required
                  />
                </div>

                {/* Email */}
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

                {/* Password */}
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

                {/* Confirm Password */}
                <div className="space-y-2">
                  <Label htmlFor="confirmPassword">Confirm Password</Label>
                  <Input
                    id="confirmPassword"
                    name="confirmPassword"
                    type="password"
                    placeholder="Confirm your password"
                    value={formData.confirmPassword}
                    onChange={handleChange}
                    required
                  />
                </div>

                {/* Terms of Service Checkbox */}
                <div className="flex items-start gap-3 pt-1">
                  <Checkbox
                    id="terms"
                    checked={termsAccepted}
                    onCheckedChange={(checked) => setTermsAccepted(checked === true)}
                    className="mt-0.5"
                  />
                  <label htmlFor="terms" className="text-sm text-gray-600 leading-snug cursor-pointer select-none">
                    I have read and agree to the{" "}
                    <button
                      type="button"
                      onClick={handleOpenTerms}
                      className="text-blue-600 hover:underline font-medium"
                    >
                      Terms of Service
                    </button>
                  </label>
                </div>

                {/* Sign Up Button */}
                <Button
                  type="submit"
                  className="w-full bg-gradient-to-r from-emerald-600 via-teal-600 to-cyan-600 hover:from-emerald-700 hover:via-teal-700 hover:to-cyan-700 shadow-lg hover:shadow-xl transition-all duration-300 text-white font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
                  disabled={isLoading || !termsAccepted}
                >
                  {isLoading ? "Creating account..." : "Create Account"}
                </Button>

                {/* Login Link */}
                <div className="text-center text-sm text-gray-600">
                  Already have an account?{" "}
                  <Link href="/auth/login" className="text-blue-600 hover:underline font-medium">
                    Sign in
                  </Link>
                </div>

                {/* Back to Home Link */}
                <div className="text-center">
                  <Link href="/" className="text-sm text-gray-600 hover:underline">
                    Back to Home
                  </Link>
                </div>
              </form>
            )}
          </CardContent>
        </Card>
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
                <Loader2 className="w-6 h-6 animate-spin text-emerald-600" />
              </div>
            ) : (
              <div className="space-y-4 text-sm py-2">
                {intro && (
                  <p className="text-gray-600 leading-relaxed">{intro}</p>
                )}
                {sections.map((s, i) => (
                  <div key={i} className="p-3 bg-slate-50 rounded-lg border border-slate-100">
                    <p className="font-bold text-gray-900 mb-1">{s.title}</p>
                    <p className="text-gray-700 leading-relaxed">{s.body}</p>
                  </div>
                ))}
                <p className="text-xs text-gray-400 pt-2 text-center">
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
              className="w-full bg-gradient-to-r from-emerald-600 via-teal-600 to-cyan-600 hover:from-emerald-700 hover:via-teal-700 hover:to-cyan-700 text-white font-semibold"
            >
              I Agree
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
