"use client"

import { useEffect, useState } from "react"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useResendCooldown } from "@/lib/use-resend-cooldown"
import { isOtpPhone } from "@/lib/storefront-commission/ui-helpers"

/**
 * Payer-phone OTP gate for storefront checkouts (same endpoints as storefront airtime). The phone that is
 * verified is the payer phone sent as `customerPhone`, which is the number the server gate checks.
 * `required` starts from the public checkout settings and is switched on if initialize answers OTP_REQUIRED.
 */
export function usePayerOtp(phone: string) {
  const [required, setRequired] = useState(false)
  const [verifiedPhone, setVerifiedPhone] = useState<string | null>(null)
  const [sent, setSent] = useState(false)
  const [code, setCode] = useState("")
  const [sending, setSending] = useState(false)
  const [verifying, setVerifying] = useState(false)
  const digits = phone.replace(/\D/g, "")
  const cooldown = useResendCooldown(digits)
  const verified = verifiedPhone !== null && verifiedPhone === digits

  useEffect(() => {
    fetch("/api/public/turnstile-status")
      .then(r => (r.ok ? r.json() : null))
      .then(d => setRequired(d?.otp_required === true))
      .catch(() => {})
  }, [])

  // A different number means a fresh code.
  useEffect(() => { setSent(false); setCode("") }, [digits])

  // Returning payers whose number was verified before skip the step.
  useEffect(() => {
    if (!required || verified || !isOtpPhone(phone)) return
    const t = setTimeout(() => {
      fetch("/api/public/phone-verified", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone }),
      })
        .then(r => (r.ok ? r.json() : { verified: false }))
        .then(d => { if (d.verified) setVerifiedPhone(digits) })
        .catch(() => {})
    }, 600)
    return () => clearTimeout(t)
  }, [phone, digits, required, verified])

  const send = async () => {
    if (!isOtpPhone(phone)) { toast.error("Enter a valid phone number first"); return }
    setSending(true)
    try {
      const res = await fetch("/api/auth/send-phone-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { toast.error(d?.error || "Failed to send code"); return }
      toast.success("Verification code sent")
      setSent(true)
      cooldown.start()
    } catch { toast.error("Network error") } finally { setSending(false) }
  }

  const verify = async () => {
    if (code.length < 4) { toast.error("Enter the code from your SMS"); return }
    setVerifying(true)
    try {
      const res = await fetch("/api/auth/verify-phone-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone, code: code.trim() }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok || !d.verified) { toast.error(d?.error || "Incorrect code"); return }
      toast.success("Phone number verified")
      setVerifiedPhone(digits)
    } catch { toast.error("Network error") } finally { setVerifying(false) }
  }

  return {
    required, verified, sent, code, sending, verifying, cooldown: cooldown.seconds,
    /** The pay button must wait while this is true. */
    blocking: required && !verified,
    require: () => setRequired(true),
    setCode: (v: string) => setCode(v.replace(/\D/g, "").slice(0, 6)),
    send, verify,
  }
}

export type PayerOtp = ReturnType<typeof usePayerOtp>

export function PayerOtpStep({ otp }: { otp: PayerOtp }) {
  if (!otp.required) return null
  if (otp.verified) return <p className="rounded-xl bg-muted px-4 py-2.5 text-sm font-medium text-foreground">Your phone number is verified.</p>
  return (
    <div className="space-y-2 rounded-2xl border border-border bg-card p-4">
      <p className="text-sm font-bold text-foreground">Verify your phone number</p>
      <p className="text-xs text-muted-foreground">We text a code to the phone number above. You verify it once.</p>
      {!otp.sent ? (
        <Button type="button" onClick={otp.send} disabled={otp.sending || otp.cooldown > 0} className="w-full rounded-2xl bg-[var(--shop-accent)] text-white hover:bg-[var(--shop-accent)]/90">
          {otp.sending ? (<><Loader2 className="mr-2 h-4 w-4 animate-spin" />Sending code...</>) : otp.cooldown > 0 ? `Resend in ${otp.cooldown}s` : "Send verification code"}
        </Button>
      ) : (
        <div className="space-y-2">
          <Input inputMode="numeric" maxLength={6} placeholder="Enter 6-digit code" value={otp.code} onChange={e => otp.setCode(e.target.value)} className="rounded-2xl border-border bg-card py-3.5 text-center font-mono tracking-widest" />
          <div className="flex gap-2">
            <Button type="button" onClick={otp.verify} disabled={otp.verifying || otp.code.length < 4} className="flex-1 rounded-2xl bg-[var(--shop-accent)] text-white hover:bg-[var(--shop-accent)]/90">
              {otp.verifying ? (<><Loader2 className="mr-2 h-4 w-4 animate-spin" />Verifying...</>) : "Verify"}
            </Button>
            <Button type="button" variant="outline" onClick={otp.send} disabled={otp.sending || otp.cooldown > 0} className="rounded-2xl">
              {otp.cooldown > 0 ? `Resend in ${otp.cooldown}s` : "Resend"}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
