"use client"

import { useState, useRef, useEffect } from "react"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { CheckCircle2, Clock, Loader2, Phone, ShieldAlert, ShieldCheck } from "lucide-react"
import { supabase } from "@/lib/supabase"
import { toast } from "sonner"

interface PhoneVerifyModalProps {
  open: boolean
  currentPhone: string
  deadline?: string
  // newPhone is passed when the user CHANGED/ADDED a number (so the caller can
  // update its display); omitted when they merely verified the existing one.
  onVerified: (newPhone?: string) => void
  onDismiss: () => void
  // When true, the user opened this voluntarily (e.g. the profile page) and may
  // close it freely. Default false keeps the dashboard ENFORCEMENT behaviour:
  // non-dismissable unless a grace deadline is active.
  dismissable?: boolean
}

function formatTimeLeft(deadline: string): string {
  const msLeft = new Date(deadline).getTime() - Date.now()
  if (msLeft <= 0) return ""
  const hours = Math.floor(msLeft / (1000 * 60 * 60))
  const minutes = Math.floor((msLeft % (1000 * 60 * 60)) / (1000 * 60))
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes} minute${minutes !== 1 ? "s" : ""}`
}

export function PhoneVerifyModal({ open, currentPhone, deadline, onVerified, onDismiss, dismissable = false }: PhoneVerifyModalProps) {
  // When there's no current phone, this modal is an ADD flow — there's nothing to
  // "verify", so force the change/add tab and hide the "Verify Current" tab.
  const isAdd = !currentPhone
  const [mode, setMode] = useState<"verify" | "change">(currentPhone ? "verify" : "change")
  // currentPhone may load after first mount (or change since the last open), so
  // re-pick the right default each time the modal opens.
  useEffect(() => {
    if (open) setMode(currentPhone ? "verify" : "change")
  }, [open, currentPhone])
  const gracePeriodActive = deadline ? new Date(deadline) > new Date() : false
  const timeLeft = deadline && gracePeriodActive ? formatTimeLeft(deadline) : ""

  // Verify existing phone state
  const [verifyOtpSent, setVerifyOtpSent] = useState(false)
  const [verifyOtpCode, setVerifyOtpCode] = useState("")
  const [verifyOtpLoading, setVerifyOtpLoading] = useState(false)
  const [verifySendLoading, setVerifySendLoading] = useState(false)
  const [verifyResendTimer, setVerifyResendTimer] = useState(0)
  const verifyTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Change phone state
  const [newPhone, setNewPhone] = useState("")
  const [changeOtpSent, setChangeOtpSent] = useState(false)
  const [changeOtpCode, setChangeOtpCode] = useState("")
  const [changePhoneVerified, setChangePhoneVerified] = useState(false)
  const [changeSendLoading, setChangeSendLoading] = useState(false)
  const [changeVerifyLoading, setChangeVerifyLoading] = useState(false)
  const [changeResendTimer, setChangeResendTimer] = useState(0)
  const [changeSaving, setChangeSaving] = useState(false)
  const changeTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const startTimer = (setter: React.Dispatch<React.SetStateAction<number>>, ref: React.MutableRefObject<ReturnType<typeof setInterval> | null>) => {
    setter(60)
    ref.current = setInterval(() => {
      setter((t) => {
        if (t <= 1) { clearInterval(ref.current!); return 0 }
        return t - 1
      })
    }, 1000)
  }

  // ── Verify existing phone ──────────────────────────────────────────────────

  const handleSendVerifyOtp = async () => {
    setVerifySendLoading(true)
    try {
      const res = await fetch("/api/auth/send-phone-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: currentPhone, purpose: "verify_phone" }),
      })
      const data = await res.json()
      if (!res.ok) { toast.error(data.error || "Failed to send OTP"); return }
      setVerifyOtpSent(true)
      setVerifyOtpCode("")
      startTimer(setVerifyResendTimer, verifyTimerRef)
      toast.success("OTP sent to your phone!")
    } catch {
      toast.error("Failed to send OTP")
    } finally {
      setVerifySendLoading(false)
    }
  }

  const handleVerifyExistingPhone = async () => {
    if (!verifyOtpCode || verifyOtpCode.length !== 6) { toast.error("Enter the 6-digit code"); return }
    setVerifyOtpLoading(true)
    try {
      // First verify the OTP
      const verifyRes = await fetch("/api/auth/verify-phone-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: currentPhone, code: verifyOtpCode, purpose: "verify_phone" }),
      })
      const verifyData = await verifyRes.json()
      if (!verifyRes.ok || !verifyData.verified) { toast.error(verifyData.error || "Invalid or expired code"); return }

      // Mark phone as verified on the user record
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) { toast.error("Not authenticated"); return }

      const res = await fetch("/api/user/verify-phone", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ phoneNumber: currentPhone }),
      })
      const data = await res.json()
      if (!res.ok) { toast.error(data.error || "Failed to verify phone"); return }

      toast.success("Phone number verified!")
      onVerified()
    } catch {
      toast.error("Failed to verify phone")
    } finally {
      setVerifyOtpLoading(false)
    }
  }

  // ── Change phone ───────────────────────────────────────────────────────────

  const handleNewPhoneChange = (value: string) => {
    setNewPhone(value)
    setChangeOtpSent(false)
    setChangeOtpCode("")
    setChangePhoneVerified(false)
  }

  const handleSendChangeOtp = async () => {
    const digits = newPhone.replace(/\D/g, "")
    if (digits.length < 9 || digits.length > 10) { toast.error("Enter a valid phone number first"); return }
    setChangeSendLoading(true)
    try {
      const res = await fetch("/api/auth/send-phone-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: newPhone, purpose: "update_phone" }),
      })
      const data = await res.json()
      if (!res.ok) { toast.error(data.error || "Failed to send OTP"); return }
      setChangeOtpSent(true)
      setChangeOtpCode("")
      startTimer(setChangeResendTimer, changeTimerRef)
      toast.success("OTP sent!")
    } catch {
      toast.error("Failed to send OTP")
    } finally {
      setChangeSendLoading(false)
    }
  }

  const handleVerifyNewPhone = async () => {
    if (!changeOtpCode || changeOtpCode.length !== 6) { toast.error("Enter the 6-digit code"); return }
    setChangeVerifyLoading(true)
    try {
      const res = await fetch("/api/auth/verify-phone-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: newPhone, code: changeOtpCode, purpose: "update_phone" }),
      })
      const data = await res.json()
      if (!res.ok || !data.verified) { toast.error(data.error || "Invalid or expired code"); return }
      setChangePhoneVerified(true)
      toast.success("New number verified!")
    } catch {
      toast.error("Failed to verify")
    } finally {
      setChangeVerifyLoading(false)
    }
  }

  const handleSaveNewPhone = async () => {
    setChangeSaving(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) { toast.error("Not authenticated"); return }

      const res = await fetch("/api/user/update-phone", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ phoneNumber: newPhone }),
      })
      const data = await res.json()
      if (!res.ok) { toast.error(data.error || "Failed to update phone"); return }

      toast.success("Phone number updated and verified!")
      onVerified(newPhone)
    } catch {
      toast.error("Failed to update phone")
    } finally {
      setChangeSaving(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(isOpen) => {
        if (!isOpen) {
          if (dismissable || gracePeriodActive) onDismiss()
          // Enforcement mode (not dismissable, no grace): block closing.
        }
      }}
    >
      <DialogContent
        className="max-w-md"
        onPointerDownOutside={(dismissable || gracePeriodActive) ? undefined : (e) => e.preventDefault()}
        onEscapeKeyDown={(dismissable || gracePeriodActive) ? undefined : (e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {isAdd
              ? <Phone className="w-5 h-5 text-primary" />
              : gracePeriodActive
                ? <ShieldCheck className="w-5 h-5 text-emerald-600" />
                : <ShieldAlert className="w-5 h-5 text-red-500" />
            }
            {isAdd ? "Add Your Phone Number" : gracePeriodActive ? "Verify Your Phone Number" : "Verification Required"}
          </DialogTitle>
          <DialogDescription>
            {isAdd
              ? "Add and verify your phone number with a one-time code to continue."
              : gracePeriodActive
                ? `Verify your phone to keep full access. You have ${timeLeft} remaining.`
                : "Your access to orders and withdrawals is restricted until you verify your phone number."
            }
          </DialogDescription>
        </DialogHeader>

        {/* Grace period countdown banner */}
        {gracePeriodActive && timeLeft && (
          <div className="flex items-center gap-2 px-3 py-2 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-700">
            <Clock className="w-4 h-4 shrink-0" />
            <span><strong>{timeLeft}</strong> remaining before orders and withdrawals are restricted</span>
          </div>
        )}

        {/* Mode tabs — only when there's an existing number to verify. For an ADD
            flow there's nothing to verify, so we go straight to the change/add UI. */}
        {!isAdd && (
          <div className="flex rounded-lg border border-border overflow-hidden text-sm">
            <button
              onClick={() => setMode("verify")}
              className={`flex-1 py-2 font-medium transition-colors ${mode === "verify" ? "bg-emerald-600 text-white" : "bg-card text-muted-foreground hover:bg-accent"}`}
            >
              Verify Current
            </button>
            <button
              onClick={() => setMode("change")}
              className={`flex-1 py-2 font-medium transition-colors ${mode === "change" ? "bg-emerald-600 text-white" : "bg-card text-muted-foreground hover:bg-accent"}`}
            >
              Change Number
            </button>
          </div>
        )}

        {mode === "verify" ? (
          <div className="space-y-4">
            <div className="flex items-center gap-3 p-3 bg-muted/40 rounded-lg border">
              <Phone className="w-4 h-4 text-muted-foreground shrink-0" />
              <span className="text-sm text-foreground font-medium">{currentPhone}</span>
            </div>

            {!verifyOtpSent ? (
              <Button onClick={handleSendVerifyOtp} disabled={verifySendLoading} className="w-full bg-emerald-600 hover:bg-emerald-700">
                {verifySendLoading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
                Send OTP to this number
              </Button>
            ) : (
              <div className="space-y-3">
                <div className="flex gap-2">
                  <Input
                    type="text"
                    inputMode="numeric"
                    maxLength={6}
                    placeholder="Enter 6-digit code"
                    value={verifyOtpCode}
                    onChange={(e) => setVerifyOtpCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                    className="flex-1"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    onClick={handleSendVerifyOtp}
                    disabled={verifySendLoading || verifyResendTimer > 0}
                    className="shrink-0 text-xs px-3"
                  >
                    {verifyResendTimer > 0 ? `${verifyResendTimer}s` : "Resend"}
                  </Button>
                </div>
                <Button onClick={handleVerifyExistingPhone} disabled={verifyOtpLoading || verifyOtpCode.length !== 6} className="w-full bg-emerald-600 hover:bg-emerald-700">
                  {verifyOtpLoading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <CheckCircle2 className="w-4 h-4 mr-2" />}
                  Confirm Verification
                </Button>
                <p className="text-xs text-muted-foreground">📩 Don&apos;t see the code? Check your phone&apos;s Spam or Blocked messages folder.</p>
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Input
                  type="tel"
                  placeholder="New phone number"
                  value={newPhone}
                  onChange={(e) => handleNewPhoneChange(e.target.value)}
                  className={changePhoneVerified ? "pr-8 border-green-500 focus-visible:ring-green-500" : ""}
                />
                {changePhoneVerified && (
                  <CheckCircle2 className="absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 text-green-500" />
                )}
              </div>
              <Button
                type="button"
                variant="outline"
                onClick={handleSendChangeOtp}
                disabled={changeSendLoading || changeResendTimer > 0 || changePhoneVerified}
                className="shrink-0 text-xs px-3"
              >
                {changeSendLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : changeResendTimer > 0 ? `${changeResendTimer}s` : changeOtpSent ? "Resend" : "Send OTP"}
              </Button>
            </div>

            {changeOtpSent && !changePhoneVerified && (
              <div className="flex gap-2">
                <Input
                  type="text"
                  inputMode="numeric"
                  maxLength={6}
                  placeholder="Enter 6-digit code"
                  value={changeOtpCode}
                  onChange={(e) => setChangeOtpCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  className="flex-1"
                />
                <Button
                  type="button"
                  variant="outline"
                  onClick={handleVerifyNewPhone}
                  disabled={changeVerifyLoading || changeOtpCode.length !== 6}
                  className="shrink-0 text-xs px-3"
                >
                  {changeVerifyLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : "Verify"}
                </Button>
              </div>
            )}

            {changeOtpSent && !changePhoneVerified && (
              <p className="text-xs text-muted-foreground">📩 Don&apos;t see the code? Check your phone&apos;s Spam or Blocked messages folder.</p>
            )}

            {changePhoneVerified && (
              <Button onClick={handleSaveNewPhone} disabled={changeSaving} className="w-full bg-emerald-600 hover:bg-emerald-700">
                {changeSaving ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
                Save New Number
              </Button>
            )}
          </div>
        )}

        {gracePeriodActive && (
          <Button variant="ghost" onClick={onDismiss} className="w-full text-muted-foreground text-sm">
            Remind me later
          </Button>
        )}
      </DialogContent>
    </Dialog>
  )
}
