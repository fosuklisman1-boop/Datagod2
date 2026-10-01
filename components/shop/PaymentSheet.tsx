"use client"

import type { ReactNode } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Loader2, X, AlertCircle } from "lucide-react"

export interface PaymentSheetModal {
  state: "sending" | "awaiting" | "otp" | "success" | "failed"
  orderId?: string
  reference?: string
  summary?: any
  message?: string
}

interface Props {
  modal: PaymentSheetModal
  /** "Cancel payment" during "sending" -- returns to the form, keeps what was typed. */
  onCancelSending: () => void
  /** X button / backdrop click for every other state -- full reset + close. */
  onDismiss: () => void
  /** "Try again" on "failed" -- returns to the form without a full reset. */
  onRetry: () => void
  otpInput: string
  setOtpInput: (v: string) => void
  onSubmitOtp: () => void
  otpSubmitting: boolean
  /** Success content differs per flow (inline summary vs. a confirmation-page redirect). */
  renderSuccess: (modal: PaymentSheetModal) => ReactNode
  /**
   * CSS color for the sheet's accent (spinners, buttons, highlighted text).
   * Storefront callers omit this and inherit the shop's own --shop-accent
   * custom property from an ancestor (set on the page root). Callers outside
   * a shop context (e.g. the dashboard) pass a real color here instead, since
   * there's no ancestor defining --shop-accent for them to inherit.
   */
  accentColor?: string
}

// The same persistent bottom sheet the Data checkout uses for its whole
// payment flow (app/shop/[slug]/page.tsx), extracted so every other
// checkout (storefront Airtime/Results Checker/Results Check Service, and
// dashboard flows like wallet top-up) shows the identical
// sending/awaiting/OTP/success/failed experience instead of each
// maintaining its own centered-popup Card.
export function PaymentSheet({ modal, onCancelSending, onDismiss, onRetry, otpInput, setOtpInput, onSubmitOtp, otpSubmitting, renderSuccess, accentColor }: Props) {
  const handleBackdropDismiss = modal.state === "sending" ? onCancelSending : onDismiss

  return (
    <div
      className="fixed inset-0 z-[60] flex items-end justify-center bg-black/50"
      style={accentColor ? ({ "--shop-accent": accentColor } as React.CSSProperties) : undefined}
      onClick={handleBackdropDismiss}
    >
      <div
        className="flex max-h-[92dvh] w-full max-w-md flex-col rounded-t-3xl bg-card"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="relative flex shrink-0 justify-center pt-3 pb-1">
          <div className="h-1 w-10 rounded-full bg-border" />
          <button
            onClick={handleBackdropDismiss}
            className="absolute right-4 top-2 grid h-8 w-8 place-items-center rounded-full bg-muted text-foreground"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {modal.state === "sending" && (
          <div className="px-5 pb-6 pt-2 text-center space-y-4">
            <div className="mx-auto h-16 w-16 rounded-full border-4 border-muted border-t-[var(--shop-accent)] animate-spin" />
            <div>
              <h3 className="text-lg font-bold text-foreground">Processing payment</h3>
              <p className="text-sm text-muted-foreground mt-1">Please keep this page open until we confirm.</p>
            </div>
            <p className="rounded-xl bg-[var(--shop-accent)]/10 px-4 py-2.5 text-sm font-medium text-[var(--shop-accent)]">
              Sending payment prompt to your phone…
            </p>
            <Button variant="outline" className="w-full" onClick={onCancelSending}>
              Cancel payment
            </Button>
          </div>
        )}

        {modal.state === "awaiting" && (
          <div className="px-5 pb-6 pt-2 text-center space-y-4">
            <div className="mx-auto w-16 h-16 rounded-full bg-[var(--shop-accent)] flex items-center justify-center">
              <Loader2 className="w-8 h-8 text-primary-foreground animate-spin" />
            </div>
            <div>
              <h3 className="text-lg font-bold text-foreground">Approve the prompt on your phone</h3>
              <p className="text-sm text-muted-foreground mt-1">
                We sent a Mobile Money prompt to{" "}
                <span className="font-semibold">{modal.summary?.paymentPhone}</span>. Enter your PIN to approve the payment of{" "}
                <span className="font-semibold">GHS {Number(modal.summary?.amount || 0).toFixed(2)}</span>.
              </p>
            </div>
            <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="w-3 h-3 animate-spin" /> Waiting for confirmation…
            </div>
            <p className="text-xs text-muted-foreground">Keep this page open. This can take up to a minute.</p>
          </div>
        )}

        {modal.state === "otp" && (
          <div className="px-5 pb-6 pt-2 text-center space-y-4">
            <div className="mx-auto w-16 h-16 rounded-full bg-[var(--shop-accent)] flex items-center justify-center">
              <svg className="w-8 h-8 text-primary-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" /></svg>
            </div>
            <div>
              <h3 className="text-lg font-bold text-foreground">Enter the code sent to your phone</h3>
              <p className="text-sm text-muted-foreground mt-1">
                Your provider sent a one-time code to{" "}
                <span className="font-semibold">{modal.summary?.paymentPhone}</span> to approve this payment.
              </p>
            </div>
            <Input
              type="text"
              inputMode="numeric"
              autoFocus
              placeholder="Enter OTP"
              value={otpInput}
              onChange={(e) => setOtpInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") onSubmitOtp() }}
              className="rounded-2xl bg-card text-center text-lg tracking-widest"
              disabled={otpSubmitting}
            />
            <Button
              onClick={onSubmitOtp}
              disabled={otpSubmitting || !otpInput.trim()}
              className="w-full rounded-2xl bg-[var(--shop-accent)] text-white hover:bg-[var(--shop-accent)]/90"
            >
              {otpSubmitting ? <Loader2 className="w-4 h-4 animate-spin" /> : "Submit code"}
            </Button>
          </div>
        )}

        {modal.state === "success" && renderSuccess(modal)}

        {modal.state === "failed" && (
          <div className="px-5 pb-6 pt-2 text-center space-y-4">
            <div className="mx-auto w-16 h-16 rounded-full bg-destructive/15 flex items-center justify-center">
              <AlertCircle className="w-9 h-9 text-destructive" />
            </div>
            <div>
              <h3 className="text-lg font-bold text-foreground">Payment not completed</h3>
              <p className="text-sm text-muted-foreground mt-1">{modal.message || "The prompt was not approved. Please try again."}</p>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" onClick={onDismiss} className="flex-1 rounded-2xl">Close</Button>
              <Button onClick={onRetry} className="flex-1 rounded-2xl bg-[var(--shop-accent)] text-white hover:bg-[var(--shop-accent)]/90">Try again</Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
