"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { AlertCircle, CheckCircle, Loader2, Smartphone } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { useResendCooldown } from "@/lib/use-resend-cooldown"
import { smsFetch } from "../_lib/api"
import { MOMO_PHONE } from "../_lib/view"
import { useSmsAccount } from "../_lib/useSmsAccount"

/** Direct-charge + OTP gates (independent admin toggles), same source as wallet top-up. */
export function useWalletGates(): { walletDirect: boolean; walletOtp: boolean } {
  const [gates, setGates] = useState({ walletDirect: false, walletOtp: false })
  useEffect(() => {
    let alive = true
    fetch("/api/public/turnstile-status")
      .then((r) => (r.ok ? r.json() : { wallet_lock: false, wallet_direct_charge: false }))
      .then((d) => { if (alive) setGates({ walletDirect: d.wallet_direct_charge === true, walletOtp: d.wallet_lock === true }) })
      .catch(() => { if (alive) setGates({ walletDirect: false, walletOtp: false }) })
    return () => { alive = false }
  }, [])
  return gates
}

type Stage = "form" | "awaiting" | "done" | "error"
interface FormState { phone: string; otpSent: boolean; otpVerified: boolean; otpCode: string; stage: Stage; message: string }
const INITIAL: FormState = { phone: "", otpSent: false, otpVerified: false, otpCode: "", stage: "form", message: "" }
const POLL_MS = 4000
const POLL_TIMEOUT_MS = 2.5 * 60 * 1000

export interface MomoDialogProps {
  open: boolean
  /** Called when the dialog should close (user dismissed it, or activation confirmed). */
  onClose: () => void
  /** GHS to charge (the activation fee). */
  cost: number
  /** Whether the MoMo number must be SMS-OTP verified before charging (admin `wallet_lock`). */
  walletOtp: boolean
}

/** On-page Mobile Money direct charge for SMS activation. */
export function MomoDialog({ open, onClose, cost, walletOtp }: MomoDialogProps) {
  const { reload } = useSmsAccount()
  const [f, setF] = useState<FormState>(INITIAL)
  const [momoBusy, setMomoBusy] = useState(false)
  const [sendingOtp, setSendingOtp] = useState(false)
  const [verifyingOtp, setVerifyingOtp] = useState(false)
  const otpCooldown = useResendCooldown(f.phone.replace(/\D/g, ""))
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pollRun = useRef(0)

  const stopPoll = useCallback(() => {
    pollRun.current++
    if (pollTimer.current) { clearTimeout(pollTimer.current); pollTimer.current = null }
  }, [])
  useEffect(() => stopPoll, [stopPoll])

  // Reset the form each time the dialog opens.
  useEffect(() => { if (open) { stopPoll(); setF(INITIAL) } }, [open, stopPoll])

  function close() {
    // Closing mid-charge must NOT stop the confirmation poll: the user may have
    // approved the prompt, and we still toast + reload when activation lands.
    // (Unmount or reopening the dialog still cancels it.)
    if (f.stage !== "awaiting") stopPoll()
    otpCooldown.reset()
    setF((m) => ({ ...m, stage: "form", otpSent: false, otpVerified: false, otpCode: "", message: "" }))
    onClose()
  }

  async function sendOtp() {
    const digits = f.phone.replace(/\D/g, "")
    if (!MOMO_PHONE.test(digits)) { toast.error("Enter a valid Mobile Money number first"); return }
    setSendingOtp(true)
    try {
      const res = await fetch("/api/auth/send-phone-otp", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: f.phone }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { toast.error(d?.error || "Failed to send code"); return }
      toast.success("Verification code sent")
      setF((m) => ({ ...m, otpSent: true })); otpCooldown.start()
    } catch { toast.error("Network error") } finally { setSendingOtp(false) }
  }

  async function verifyOtp() {
    if (!f.otpCode || f.otpCode.length < 4) { toast.error("Enter the code from your SMS"); return }
    setVerifyingOtp(true)
    try {
      const res = await fetch("/api/auth/verify-phone-otp", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: f.phone, code: f.otpCode.trim() }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok || !d.verified) { toast.error(d?.error || "Incorrect code"); return }
      toast.success("Payment number verified ✓")
      setF((m) => ({ ...m, otpVerified: true }))
    } catch { toast.error("Network error") } finally { setVerifyingOtp(false) }
  }

  // Poll the SMS account (NOT /api/payments/momo-status — direct SMS charges create
  // no wallet_payments row) until the webhook has activated the account.
  function pollActivation() {
    stopPoll()
    const run = pollRun.current
    const started = Date.now()
    const tick = async () => {
      if (run !== pollRun.current) return
      if (Date.now() - started > POLL_TIMEOUT_MS) {
        setF((m) => ({ ...m, stage: "error", message: "If you approved the prompt, your activation will appear shortly — refresh in a moment." }))
        return
      }
      const res = await smsFetch<{ account?: { status?: string } }>("/api/sms/account")
      if (run !== pollRun.current) return
      if (res.ok && (res.body.account as { status?: string } | undefined)?.status === "active") {
        toast.success("Account activated 🎉")
        stopPoll()
        setF(INITIAL)
        onClose()
        await reload()
        return
      }
      pollTimer.current = setTimeout(tick, POLL_MS)
    }
    pollTimer.current = setTimeout(tick, POLL_MS)
  }

  async function payWithMomo() {
    const digits = f.phone.replace(/\D/g, "")
    if (!MOMO_PHONE.test(digits)) { toast.error("Enter a valid Mobile Money number"); return }
    if (walletOtp && !f.otpVerified) { toast.error("Verify your Mobile Money number first"); return }
    setMomoBusy(true)
    try {
      const res = await smsFetch("/api/sms/activate", {
        method: "POST",
        body: JSON.stringify({ paidFrom: "paystack", momoDirect: true, paymentPhone: f.phone }),
      })
      if (!res.ok && res.status === 403 && res.code === "OTP_REQUIRED") {
        toast.error("Verify your payment number to continue.")
        setF((m) => ({ ...m, stage: "form", otpVerified: false, otpSent: false, otpCode: "" }))
        return
      }
      if (res.ok && res.body.momoDirect === true) {
        setF((m) => ({ ...m, stage: "awaiting", message: "" }))
        pollActivation()
        return
      }
      const msg = !res.ok && res.error && !res.error.startsWith("HTTP ") ? res.error : "Could not start the Mobile Money charge. Please try again."
      setF((m) => ({ ...m, stage: "error", message: msg }))
    } catch {
      setF((m) => ({ ...m, stage: "error", message: "Network error. Please try again." }))
    } finally {
      setMomoBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) close() }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Smartphone className="h-5 w-5 text-primary" /> Activate with Mobile Money
          </DialogTitle>
          <DialogDescription>One-time activation · GHS {cost.toFixed(2)}</DialogDescription>
        </DialogHeader>

        {f.stage === "form" && (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="momo-phone">Mobile Money number to pay from</Label>
              <Input
                id="momo-phone" type="tel" inputMode="numeric" placeholder="0241234567" value={f.phone}
                onChange={(e) => {
                  const phone = e.target.value
                  setF((m) => ({
                    ...m, phone,
                    // editing the number invalidates a prior verify
                    ...(m.otpSent || m.otpVerified ? { otpSent: false, otpVerified: false, otpCode: "" } : {}),
                  }))
                  if (f.otpSent || f.otpVerified) otpCooldown.reset()
                }}
                disabled={(walletOtp && f.otpVerified) || momoBusy}
                className="font-mono"
              />
              <p className="text-xs text-muted-foreground">The payment prompt is sent to this number.</p>
            </div>

            {walletOtp && (!f.otpVerified ? (
              !f.otpSent ? (
                <Button type="button" variant="outline" onClick={sendOtp} disabled={sendingOtp || otpCooldown.seconds > 0} className="w-full">
                  {sendingOtp ? (<><Loader2 className="mr-2 h-4 w-4 animate-spin" />Sending code…</>) : otpCooldown.seconds > 0 ? `Resend in ${otpCooldown.seconds}s` : "Send verification code"}
                </Button>
              ) : (
                <div className="space-y-2">
                  <Input
                    inputMode="numeric" maxLength={6} placeholder="Enter 6-digit code" value={f.otpCode}
                    onChange={(e) => setF((m) => ({ ...m, otpCode: e.target.value.replace(/\D/g, "").slice(0, 6) }))}
                    className="text-center font-mono text-lg tracking-[0.4em]"
                  />
                  <div className="flex gap-2">
                    <Button type="button" onClick={verifyOtp} disabled={verifyingOtp || f.otpCode.length < 4} className="flex-1">
                      {verifyingOtp ? (<><Loader2 className="mr-2 h-4 w-4 animate-spin" />Verifying…</>) : "Verify"}
                    </Button>
                    <Button type="button" variant="outline" onClick={sendOtp} disabled={sendingOtp || otpCooldown.seconds > 0}>
                      {otpCooldown.seconds > 0 ? `Resend in ${otpCooldown.seconds}s` : "Resend"}
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">Don&apos;t see the code? Check your phone&apos;s Spam or Blocked messages folder.</p>
                </div>
              )
            ) : (
              <div className="flex items-center gap-2 rounded-lg border border-success/30 bg-success/10 p-3">
                <CheckCircle className="h-5 w-5 text-success" />
                <span className="text-sm font-medium text-foreground">Payment number verified ✓</span>
              </div>
            ))}

            <Button
              onClick={payWithMomo}
              disabled={momoBusy || !MOMO_PHONE.test(f.phone.replace(/\D/g, "")) || (walletOtp && !f.otpVerified)}
              className="w-full"
            >
              {momoBusy ? (<><Loader2 className="mr-2 h-4 w-4 animate-spin" />Starting…</>) : `Pay GHS ${cost.toFixed(2)}`}
            </Button>
          </div>
        )}

        {f.stage === "awaiting" && (
          <div className="space-y-4 py-2 text-center">
            <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-primary/10">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
            </div>
            <div>
              <h3 className="text-lg font-bold">Approve the prompt on your phone</h3>
              <p className="mt-1 text-sm text-muted-foreground">Approve the Mobile Money prompt on your phone to complete payment.</p>
            </div>
            <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" /> Waiting for confirmation…
            </div>
            <p className="text-xs text-muted-foreground">Keep this page open. This can take up to a minute.</p>
          </div>
        )}

        {f.stage === "done" && (
          <div className="space-y-4 py-2 text-center">
            <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-success/15">
              <CheckCircle className="h-9 w-9 text-success" />
            </div>
            <h3 className="text-lg font-bold">Account activated 🎉</h3>
            <Button onClick={close} className="w-full">Done</Button>
          </div>
        )}

        {f.stage === "error" && (
          <div className="space-y-4 py-2 text-center">
            <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-destructive/15">
              <AlertCircle className="h-9 w-9 text-destructive" />
            </div>
            <p className="text-sm text-muted-foreground">{f.message || "The payment was not completed. Please try again."}</p>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setF((m) => ({ ...m, stage: "form", message: "" }))} className="flex-1">Try again</Button>
              <Button variant="ghost" onClick={close} className="flex-1">Close</Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
