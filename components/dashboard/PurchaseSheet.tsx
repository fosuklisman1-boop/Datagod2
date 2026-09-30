"use client"

import type { ReactNode } from "react"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { X, AlertCircle } from "lucide-react"
import { validatePhoneNumber } from "@/lib/phone-validation"

export interface PurchaseSheetModal {
  state: "phone" | "processing" | "success" | "failed"
  message?: string
  /** Free-form payload for renderSuccess (e.g. package/amount/reference/new balance). */
  summary?: any
}

interface Props {
  modal: PurchaseSheetModal
  /** Context shown on the "phone" step. Only needed by callers that use it (Data Packages, Buy Data). */
  packageName?: string
  network?: string
  onSubmitPhone?: (phone: string) => void
  /** Backdrop/X on "phone" or "processing" -- returns to the page, keeps whatever was already typed. */
  onCancel: () => void
  /** Backdrop/X on "success" or "failed" -- full reset + close. */
  onDismiss: () => void
  onRetry?: () => void
  accentColor?: string
  renderSuccess: (modal: PurchaseSheetModal) => ReactNode
}

// A dashboard equivalent of components/shop/PaymentSheet.tsx: one persistent
// bottom sheet for the whole purchase flow instead of a PhoneNumberModal
// closing and a separate, differently-styled SuccessModal opening in its
// place. Purchases here are synchronous wallet debits (no external MoMo
// prompt to await/OTP for), so the state machine is simpler than the
// storefront's direct-charge sheet: phone (optional -- skip straight to
// "processing" when the caller's own form already collected the number) ->
// processing -> success -> failed.
export function PurchaseSheet({ modal, packageName, network, onSubmitPhone, onCancel, onDismiss, onRetry, accentColor, renderSuccess }: Props) {
  const [phoneNumber, setPhoneNumber] = useState("")
  const [phoneError, setPhoneError] = useState<string | null>(null)

  const handleBackdropDismiss = modal.state === "phone" || modal.state === "processing" ? onCancel : onDismiss

  const handlePhoneSubmit = () => {
    const result = validatePhoneNumber(phoneNumber, network)
    if (!result.isValid) {
      setPhoneError(result.error || "Invalid phone number")
      return
    }
    setPhoneError(null)
    onSubmitPhone?.(result.normalized)
    setPhoneNumber("")
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/50"
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

        {modal.state === "phone" && (
          <div className="px-5 pb-6 pt-2 space-y-4">
            <div className="text-center">
              <h3 className="text-lg font-bold text-foreground">Confirm phone number</h3>
              <p className="text-sm text-muted-foreground mt-1">Enter the phone number for your {packageName || "order"}</p>
            </div>
            {phoneError && (
              <div className="flex items-start gap-2 rounded-2xl border border-destructive/20 bg-destructive/10 p-3 text-sm text-destructive">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{phoneError}</span>
              </div>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="purchase-sheet-phone">Phone Number</Label>
              <Input
                id="purchase-sheet-phone"
                type="tel"
                autoFocus
                placeholder="e.g., 0201234567 or 201234567"
                value={phoneNumber}
                onChange={(e) => { setPhoneNumber(e.target.value); setPhoneError(null) }}
                onKeyDown={(e) => { if (e.key === "Enter") handlePhoneSubmit() }}
                className="rounded-2xl"
              />
              <p className="text-xs text-muted-foreground">Format: 9 or 10 digits starting with 02 or 05</p>
            </div>
            <Button
              onClick={handlePhoneSubmit}
              disabled={!phoneNumber.trim()}
              className="w-full rounded-2xl bg-[var(--shop-accent)] text-white hover:bg-[var(--shop-accent)]/90"
            >
              Confirm Purchase
            </Button>
          </div>
        )}

        {modal.state === "processing" && (
          <div className="px-5 pb-6 pt-2 text-center space-y-4">
            <div className="mx-auto h-16 w-16 rounded-full border-4 border-muted border-t-[var(--shop-accent)] animate-spin" />
            <div>
              <h3 className="text-lg font-bold text-foreground">Processing your order</h3>
              <p className="text-sm text-muted-foreground mt-1">This only takes a moment.</p>
            </div>
          </div>
        )}

        {modal.state === "success" && renderSuccess(modal)}

        {modal.state === "failed" && (
          <div className="px-5 pb-6 pt-2 text-center space-y-4">
            <div className="mx-auto w-16 h-16 rounded-full bg-destructive/15 flex items-center justify-center">
              <AlertCircle className="w-9 h-9 text-destructive" />
            </div>
            <div>
              <h3 className="text-lg font-bold text-foreground">Order not completed</h3>
              <p className="text-sm text-muted-foreground mt-1">{modal.message || "Something went wrong. Please try again."}</p>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" onClick={onDismiss} className="flex-1 rounded-2xl">Close</Button>
              {onRetry && (
                <Button onClick={onRetry} className="flex-1 rounded-2xl bg-[var(--shop-accent)] text-white hover:bg-[var(--shop-accent)]/90">Try again</Button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
