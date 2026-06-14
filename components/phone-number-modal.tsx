"use client"

import { useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { AlertCircle, ArrowRight, Loader2 } from "lucide-react"
import { validatePhoneNumber } from "@/lib/phone-validation"
import { getNetworkTheme, formatNetworkLabel } from "@/lib/network-theme"
import { cn } from "@/lib/utils"

interface PhoneNumberModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (phoneNumber: string) => void
  isLoading?: boolean
  packageName?: string
  network?: string
  size?: string
  price?: number
  walletBalance?: number
  validityLabel?: string
  logo?: string
}

export function PhoneNumberModal({
  open,
  onOpenChange,
  onSubmit,
  isLoading = false,
  packageName = "Data Package",
  network,
  size,
  price = 0,
  walletBalance = 0,
  validityLabel = "No expiry",
  logo,
}: PhoneNumberModalProps) {
  const [phoneNumber, setPhoneNumber] = useState("")
  const [error, setError] = useState<string | null>(null)

  const theme = getNetworkTheme(network ?? "")
  const after = walletBalance - price

  const handleSubmit = () => {
    const result = validatePhoneNumber(phoneNumber, network)
    if (!result.isValid) {
      setError(result.error || "Invalid phone number")
      return
    }

    setError(null)
    onSubmit(result.normalized)
    setPhoneNumber("")
  }

  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen) {
      setPhoneNumber("")
      setError(null)
    }
    onOpenChange(newOpen)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        showCloseButton
        // Don't yank focus to the phone input on open — that forces the mobile
        // keyboard up before the sheet finishes sliding in. User taps to focus.
        onOpenAutoFocus={(e) => e.preventDefault()}
        className={cn(
          "p-0 gap-0 border-0 bg-card overflow-hidden",
          "max-w-full w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl",
          "fixed left-0 right-0 bottom-0 top-auto translate-x-0 translate-y-0",
          "sm:left-[50%] sm:top-[50%] sm:bottom-auto sm:right-auto sm:translate-x-[-50%] sm:translate-y-[-50%]",
          "data-[state=open]:slide-in-from-bottom data-[state=closed]:slide-out-to-bottom",
          "sm:data-[state=open]:zoom-in-95 sm:data-[state=closed]:zoom-out-95",
          "data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0 duration-300"
        )}
      >
        <DialogTitle className="sr-only">Confirm Phone Number</DialogTitle>

        {/* Drag handle */}
        <div className="flex justify-center pt-2 pb-1">
          <div className="h-1.5 w-10 rounded-full bg-muted" />
        </div>

        {/* Network summary banner */}
        <div className="px-3 sm:px-4 pb-3">
          <div
            className="rounded-2xl px-4 py-4 flex items-center justify-between gap-3"
            style={{ backgroundColor: theme.hex, color: theme.text }}
          >
            <div className="flex items-center gap-3 min-w-0">
              <div className="h-10 w-10 rounded-xl bg-white/90 flex items-center justify-center shrink-0 overflow-hidden">
                {logo ? (
                  <img src={logo} alt={network} className="h-7 w-7 object-contain" />
                ) : (
                  <span className="text-sm font-bold" style={{ color: theme.hex }}>
                    {(network ?? packageName).charAt(0)}
                  </span>
                )}
              </div>
              <div className="min-w-0">
                <p className="text-xs font-medium uppercase tracking-wide opacity-80 truncate">
                  {network ? formatNetworkLabel(network) : packageName} · {validityLabel}
                </p>
                <p className="text-2xl font-bold truncate">{size ?? packageName}</p>
              </div>
            </div>
            <p className="text-xl sm:text-2xl font-bold whitespace-nowrap">GH₵{price.toFixed(2)}</p>
          </div>
        </div>

        {/* Form */}
        <div className="px-4 sm:px-5 pb-4 sm:pb-5 space-y-4">
          {error && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="phone" className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Send To
            </Label>
            <Input
              id="phone"
              placeholder="0241234567"
              value={phoneNumber}
              onChange={(e) => {
                setPhoneNumber(e.target.value)
                setError(null)
              }}
              disabled={isLoading}
              type="tel"
              className="h-12 rounded-full px-4 text-base border-2 focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:border-blue-500"
            />
          </div>

          <div className="flex items-center justify-between text-sm px-1">
            <span className="text-muted-foreground">
              Wallet: <span className="font-semibold text-foreground">GH₵{walletBalance.toFixed(2)}</span>
            </span>
            <span className="text-muted-foreground">
              After:{" "}
              <span className={cn("font-semibold", after >= 0 ? "text-green-600" : "text-red-600")}>
                GH₵{after.toFixed(2)}
              </span>
            </span>
          </div>

          <div className="relative">
            <Button
              type="button"
              onClick={handleSubmit}
              disabled={isLoading || !phoneNumber.trim()}
              style={{ backgroundColor: theme.hex, color: theme.text }}
              className="w-full h-14 rounded-full font-bold text-base shadow-lg hover:opacity-90 transition-opacity disabled:opacity-60"
            >
              {isLoading ? "Processing..." : `Pay GH₵${price.toFixed(2)}`}
            </Button>
            <div className="absolute right-1 top-1/2 -translate-y-1/2 h-12 w-12 rounded-full bg-white shadow-md flex items-center justify-center pointer-events-none">
              {isLoading ? (
                <Loader2 className="h-5 w-5 animate-spin" style={{ color: theme.hex }} />
              ) : (
                <ArrowRight className="h-5 w-5" style={{ color: theme.hex }} />
              )}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
