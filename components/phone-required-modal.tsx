"use client"

import { useState, useRef } from "react"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Phone, Loader2, MessageCircle, AlertTriangle, CheckCircle2, LogOut } from "lucide-react"
import { supabase } from "@/lib/supabase"
import { toast } from "sonner"

interface PhoneRequiredModalProps {
  open: boolean
  onPhoneSaved: (phone: string) => void
}

const SUPPORT_WHATSAPP = "233559717923"

export function PhoneRequiredModal({ open, onPhoneSaved }: PhoneRequiredModalProps) {
  const [phone, setPhone] = useState("")
  const [isSaving, setIsSaving] = useState(false)
  const [loggingOut, setLoggingOut] = useState(false)
  const [phoneExistsError, setPhoneExistsError] = useState(false)

  // OTP state
  const [otpSent, setOtpSent] = useState(false)
  const [otpCode, setOtpCode] = useState("")
  const [phoneVerified, setPhoneVerified] = useState(false)
  const [otpLoading, setOtpLoading] = useState(false)
  const [verifyLoading, setVerifyLoading] = useState(false)
  const [resendTimer, setResendTimer] = useState(0)
  const resendTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const handlePhoneChange = (value: string) => {
    setPhone(value)
    setPhoneExistsError(false)
    setOtpSent(false)
    setOtpCode("")
    setPhoneVerified(false)
  }

  const startResendTimer = () => {
    setResendTimer(60)
    resendTimerRef.current = setInterval(() => {
      setResendTimer((t) => {
        if (t <= 1) { clearInterval(resendTimerRef.current!); return 0 }
        return t - 1
      })
    }, 1000)
  }

  const handleSendOtp = async () => {
    const phoneDigits = phone.replace(/\D/g, "")
    if (phoneDigits.length < 9 || phoneDigits.length > 10) {
      toast.error("Enter a valid phone number (9-10 digits) first")
      return
    }
    setOtpLoading(true)
    try {
      const res = await fetch("/api/auth/send-phone-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone, purpose: "update_phone" }),
      })
      const data = await res.json()
      if (!res.ok) { toast.error(data.error || "Failed to send OTP"); return }
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
    if (!otpCode || otpCode.length !== 6) { toast.error("Enter the 6-digit OTP"); return }
    setVerifyLoading(true)
    try {
      const res = await fetch("/api/auth/verify-phone-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone, code: otpCode, purpose: "update_phone" }),
      })
      const data = await res.json()
      if (!res.ok || !data.verified) { toast.error(data.error || "Invalid or expired code"); return }
      setPhoneVerified(true)
      toast.success("Phone number verified!")
    } catch {
      toast.error("Failed to verify OTP")
    } finally {
      setVerifyLoading(false)
    }
  }

  const handleSavePhone = async () => {
    setPhoneExistsError(false)

    if (!phone || phone.trim() === "") { toast.error("Phone number is required"); return }
    const phoneDigits = phone.replace(/\D/g, "")
    if (phoneDigits.length < 9 || phoneDigits.length > 10) { toast.error("Phone number must be 9 or 10 digits"); return }
    if (!phoneVerified) { toast.error("Please verify your phone number first"); return }

    setIsSaving(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) { toast.error("Not authenticated"); return }

      const response = await fetch("/api/user/update-phone", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ phoneNumber: phone }),
      })

      const data = await response.json()

      if (!response.ok) {
        if (data.error?.toLowerCase().includes("already registered") || data.error?.toLowerCase().includes("already exists")) {
          setPhoneExistsError(true)
        } else {
          toast.error(data.error || "Failed to save phone number")
        }
        return
      }

      toast.success("Phone number saved successfully!")
      onPhoneSaved(phone)
    } catch {
      toast.error("Failed to save phone number")
    } finally {
      setIsSaving(false)
    }
  }

  const handleContactSupport = () => {
    const message = encodeURIComponent(`Hello, I'm having an issue with my phone number. It says "${phone}" is already registered but I believe this is my number. Can you please help?`)
    window.open(`https://wa.me/${SUPPORT_WHATSAPP}?text=${message}`, "_blank")
  }

  const handleLogout = async () => {
    setLoggingOut(true)
    try {
      await supabase.auth.signOut()
    } catch { /* best-effort — navigate away regardless */ }
    // Full navigation so all in-memory + auth state is cleared.
    window.location.href = "/auth/login"
  }

  return (
    <Dialog open={open} onOpenChange={() => {
      toast.error("Please add your phone number to continue")
    }}>
      <DialogContent className="max-w-md" onPointerDownOutside={(e) => e.preventDefault()} onEscapeKeyDown={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Phone className="w-5 h-5 text-primary" />
            Phone Number Required
          </DialogTitle>
          <DialogDescription>
            Please add and verify your phone number to continue. This helps us send important order updates.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {phoneExistsError && (
            <div className="bg-warning/10 border border-border rounded-lg p-4">
              <div className="flex items-start gap-3">
                <AlertTriangle className="w-5 h-5 text-warning flex-shrink-0 mt-0.5" />
                <div className="space-y-2">
                  <p className="text-sm text-warning font-medium">This phone number is already registered</p>
                  <p className="text-xs text-warning">If you believe this is your number, please contact support.</p>
                  <Button onClick={handleContactSupport} variant="outline" size="sm" className="mt-2 border-border text-warning hover:bg-warning/15">
                    <MessageCircle className="w-4 h-4 mr-2" />
                    Contact Support on WhatsApp
                  </Button>
                </div>
              </div>
            </div>
          )}

          {/* Phone + Send OTP */}
          <div>
            <label className="text-sm font-medium text-foreground">Phone Number *</label>
            <div className="flex gap-2 mt-1">
              <div className="relative flex-1">
                <Input
                  type="tel"
                  placeholder="Enter your phone number"
                  value={phone}
                  onChange={(e) => handlePhoneChange(e.target.value)}
                  disabled={isSaving}
                  className={phoneVerified ? "pr-8 border-success/30 focus-visible:ring-success/30" : ""}
                />
                {phoneVerified && (
                  <CheckCircle2 className="absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 text-success" />
                )}
              </div>
              <Button
                type="button"
                variant="outline"
                onClick={handleSendOtp}
                disabled={otpLoading || resendTimer > 0 || phoneVerified || isSaving}
                className="shrink-0 text-xs px-3"
              >
                {otpLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : resendTimer > 0 ? `${resendTimer}s` : otpSent ? "Resend" : "Send OTP"}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground mt-1">Must be 9 or 10 digits</p>
          </div>

          {/* OTP input */}
          {otpSent && !phoneVerified && (
            <>
            <div className="flex gap-2">
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

          <Button
            onClick={handleSavePhone}
            disabled={isSaving || !phone || !phoneVerified}
            className="w-full bg-primary hover:bg-primary/90"
          >
            {isSaving && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
            {isSaving ? "Saving..." : "Save Phone Number"}
          </Button>

          {/* Escape hatch: a user who won't/can't add a phone can leave instead of
              being trapped behind this non-dismissable modal. */}
          <Button
            type="button"
            variant="ghost"
            onClick={handleLogout}
            disabled={loggingOut || isSaving}
            className="w-full text-muted-foreground hover:text-foreground text-sm"
          >
            {loggingOut ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <LogOut className="w-4 h-4 mr-2" />}
            Log out
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
