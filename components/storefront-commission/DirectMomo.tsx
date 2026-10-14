"use client"

import { useEffect, useRef, useState } from "react"
import { CheckCircle2, Loader2 } from "lucide-react"
import { toast } from "sonner"
import { PaymentSheet, type PaymentSheetModal } from "@/components/shop/PaymentSheet"
import { useShopBasePath } from "@/lib/shop-url"
import type { StorefrontOrderType } from "@/lib/storefront-commission/payment"
import { isDirectChargeOffResponse, isOtpRequiredResponse } from "@/lib/storefront-commission/ui-helpers"
import type { PayerOtp } from "@/components/storefront-commission/PayerOtp"

const POLL_MS = 3000
const POLL_TIMEOUT_MS = 4 * 60 * 1000

export interface PayArgs {
  orderId: string
  /** Display only: the server charges the order's paid_amount from the database. */
  amount: number
  email: string
  /** The payer MoMo number (the buyer phone, OTP-verified when the OTP gate is on). */
  paymentPhone: string
}

/** started: the on-page sheet is running; redirecting: hosted checkout; otp_required: verify the phone first; failed: shown in the sheet. */
export type PayResult = "started" | "redirecting" | "otp_required" | "failed"

/**
 * Payment for a storefront bill / bundle order once it exists. With the storefront direct-charge toggle on, the payer's
 * MoMo number is charged on-page (payments/initialize momoDirect: hosted Paystack strips MoMo while it is on), with the
 * same sheet as storefront airtime: prompt / Telecel OTP / status polling, then the payment-confirmation page. With it
 * off, the hosted Paystack checkout. Nothing about the product is sent either way.
 */
export function useStorefrontPayment(shopSlug: string, orderType: StorefrontOrderType, otp: PayerOtp) {
  const base = useShopBasePath(shopSlug)
  const [modal, setModal] = useState<PaymentSheetModal | null>(null)
  const [otpInput, setOtpInput] = useState("")
  const [otpSubmitting, setOtpSubmitting] = useState(false)
  // A newer attempt or a dismissed sheet stops older polls / late responses from reopening a view.
  const run = useRef(0)
  const dismissed = useRef(false)
  useEffect(() => () => { run.current++ }, [])

  const confirmationUrl = (orderId: string, reference: string) =>
    `${base}/payment-confirmation?reference=${encodeURIComponent(reference)}&orderId=${encodeURIComponent(orderId)}`

  const show = (id: number, m: PaymentSheetModal | null) => { if (id === run.current && !dismissed.current) setModal(m) }

  const poll = (id: number, orderId: string, reference: string, summary: PaymentSheetModal["summary"]) => {
    const started = Date.now()
    const tick = async () => {
      if (id !== run.current || dismissed.current) return
      if (Date.now() - started > POLL_TIMEOUT_MS) {
        show(id, { state: "failed", message: "Payment timed out. If you approved the prompt, your order will still be completed; otherwise try again." })
        return
      }
      try {
        const res = await fetch(`/api/payments/momo-status?orderId=${encodeURIComponent(orderId)}&orderType=${orderType}&reference=${encodeURIComponent(reference)}`, { cache: "no-store" })
        const d = await res.json().catch(() => ({ status: "pending" }))
        if (d.status === "completed") {
          show(id, { state: "success", orderId, reference, summary })
          if (id === run.current && !dismissed.current) window.location.href = confirmationUrl(orderId, reference)
          return
        }
        if (d.status === "failed") { show(id, { state: "failed", message: "Payment was not completed. Please try again." }); return }
      } catch { /* keep polling */ }
      setTimeout(tick, POLL_MS)
    }
    setTimeout(tick, POLL_MS)
  }

  const hosted = async (a: PayArgs): Promise<PayResult> => {
    const res = await fetch("/api/payments/initialize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amount: a.amount, email: a.email, orderId: a.orderId, orderType, shopSlug }),
    })
    const json = await res.json().catch(() => null)
    if (!res.ok) throw new Error(json?.error || "Payment initialization failed")
    if (!json?.authorizationUrl) throw new Error("No payment URL received")
    window.location.href = json.authorizationUrl
    return "redirecting"
  }

  /** Throws (hosted path only) with a message for the form. */
  const pay = async (a: PayArgs): Promise<PayResult> => {
    if (!otp.directCharge) return hosted(a)
    const id = ++run.current
    dismissed.current = false
    setOtpInput("")
    setOtpSubmitting(false)
    setModal({ state: "sending" })
    let status = 0
    let json: any = null
    try {
      const res = await fetch("/api/payments/initialize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount: a.amount, email: a.email, orderId: a.orderId, orderType, shopSlug, momoDirect: true, paymentPhone: a.paymentPhone }),
      })
      status = res.status
      json = await res.json().catch(() => null)
    } catch {
      show(id, { state: "failed", message: "We could not confirm the payment request. If a prompt arrives on your phone, approve it; otherwise try again." })
      return "failed"
    }
    if (isOtpRequiredResponse(status, json)) {
      if (id === run.current) setModal(null)
      return "otp_required"
    }
    if (isDirectChargeOffResponse(status, json)) {
      // The toggle was switched off after the page loaded: the hosted checkout is the right path now.
      otp.disableDirectCharge()
      if (id === run.current) setModal(null)
      return hosted(a)
    }
    if (status !== 200 || !json?.success || typeof json.reference !== "string") {
      show(id, { state: "failed", message: typeof json?.error === "string" && json.error ? json.error : "Could not start the Mobile Money payment. Please try again." })
      return "failed"
    }
    const summary = { paymentPhone: a.paymentPhone, amount: a.amount, reference: json.reference }
    show(id, { state: json.status === "send_otp" ? "otp" : "awaiting", orderId: a.orderId, reference: json.reference, summary })
    poll(id, a.orderId, json.reference, summary)
    return "started"
  }

  // Telecel Cash: forward the provider's code. Success only means it was accepted; the poll picks up the result.
  const submitOtp = async () => {
    if (!modal || modal.state !== "otp" || !otpInput.trim()) return
    const id = run.current
    setOtpSubmitting(true)
    try {
      const res = await fetch("/api/payments/submit-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reference: modal.reference, otp: otpInput.trim(), orderId: modal.orderId, orderType }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok || !d.success) {
        toast.error(d.error || "That code was rejected. Please try again.")
      } else {
        show(id, { state: "awaiting", orderId: modal.orderId, reference: modal.reference, summary: modal.summary })
        setOtpInput("")
      }
    } catch {
      toast.error("Could not submit the code. Please try again.")
    }
    setOtpSubmitting(false)
  }

  const close = () => { dismissed.current = true; run.current++; setModal(null); setOtpInput(""); setOtpSubmitting(false) }

  const sheet = modal ? (
    <PaymentSheet
      modal={modal}
      onCancelSending={close}
      onDismiss={close}
      onRetry={close}
      otpInput={otpInput}
      setOtpInput={setOtpInput}
      onSubmitOtp={submitOtp}
      otpSubmitting={otpSubmitting}
      renderSuccess={(m) => (
        <div className="space-y-4 px-5 pb-6 pt-2 text-center">
          <div className="mx-auto grid h-16 w-16 place-items-center rounded-full bg-success/15">
            <CheckCircle2 className="h-9 w-9 text-success" />
          </div>
          <div>
            <h3 className="text-lg font-bold text-foreground">Payment received</h3>
            <p className="mt-1 flex items-center justify-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" /> Opening your order status…
            </p>
          </div>
          {m.orderId && m.reference && (
            <a href={confirmationUrl(m.orderId, m.reference)} className="block w-full rounded-2xl bg-[var(--shop-accent)] py-3 text-sm font-bold text-white">
              View order status
            </a>
          )}
        </div>
      )}
    />
  ) : null

  return { pay, sheet, directCharge: otp.directCharge }
}
