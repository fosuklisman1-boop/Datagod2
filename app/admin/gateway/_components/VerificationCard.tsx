"use client"

// Moved as-is from /admin/settings: checkout phone-OTP gate, wallet & upgrade
// payment protection, and reset-all-phone-verifications. Same endpoints, same copy.

import { useEffect, useState } from "react"
import { ShieldCheck } from "lucide-react"
import { toast } from "sonner"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { adminFetch } from "../_lib/api"

export function VerificationCard() {
  const [checkoutOtpEnabled, setCheckoutOtpEnabled] = useState(false)
  const [savingCheckoutOtp, setSavingCheckoutOtp] = useState(false)
  const [walletLockEnabled, setWalletLockEnabled] = useState(false)
  const [savingWalletLock, setSavingWalletLock] = useState(false)
  const [verifiedCount, setVerifiedCount] = useState<number | null>(null)
  const [resettingVerifications, setResettingVerifications] = useState(false)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    const load = async () => {
      const [otp, wl, verif] = await Promise.allSettled([
        adminFetch<{ enabled?: unknown }>("/api/admin/settings/storefront-otp"),
        adminFetch<{ enabled?: unknown }>("/api/admin/settings/wallet-otp"),
        adminFetch<{ verified?: unknown }>("/api/admin/phone-verifications/reset"),
      ])
      if (otp.status === "fulfilled" && typeof otp.value.enabled === "boolean") setCheckoutOtpEnabled(otp.value.enabled)
      if (wl.status === "fulfilled" && typeof wl.value.enabled === "boolean") setWalletLockEnabled(wl.value.enabled)
      if (verif.status === "fulfilled" && typeof verif.value.verified === "number") setVerifiedCount(verif.value.verified)
      if (otp.status === "rejected" || wl.status === "rejected") toast.error("Failed to load verification settings")
      setLoaded(true)
    }
    load()
  }, [])

  const handleCheckoutOtpToggle = async (enabled: boolean) => {
    setSavingCheckoutOtp(true)
    try {
      await adminFetch("/api/admin/settings/storefront-otp", { method: "POST", body: { enabled } })
      setCheckoutOtpEnabled(enabled)
      toast.success(
        enabled
          ? "🔐 Checkout phone-OTP is now REQUIRED — guests must verify their phone"
          : "Checkout phone-OTP disabled — guest checkout open"
      )
    } catch (error) {
      console.error("Error updating checkout OTP:", error)
      toast.error(error instanceof Error ? error.message : "Failed to update checkout OTP setting")
    } finally {
      setSavingCheckoutOtp(false)
    }
  }

  const handleWalletLockToggle = async (enabled: boolean) => {
    setSavingWalletLock(true)
    try {
      await adminFetch("/api/admin/settings/wallet-otp", { method: "POST", body: { enabled } })
      setWalletLockEnabled(enabled)
      toast.success(
        enabled
          ? "🔐 Wallet & upgrade protection ON — top-ups/upgrades can't send MoMo prompts (card/bank only)"
          : "Wallet & upgrade protection OFF — MoMo top-ups/upgrades open again"
      )
    } catch (error) {
      console.error("Error updating wallet protection:", error)
      toast.error(error instanceof Error ? error.message : "Failed to update wallet protection setting")
    } finally {
      setSavingWalletLock(false)
    }
  }

  const handleResetVerifications = async () => {
    if (!window.confirm(
      "Reset ALL phone verifications?\n\nEvery customer — including returning ones — will have to verify their payment number again (one SMS) on their next order. This also clears any numbers an attacker verified.\n\nContinue?"
    )) return
    setResettingVerifications(true)
    try {
      const data = await adminFetch<{ deleted?: number }>("/api/admin/phone-verifications/reset", { method: "POST", body: {} })
      setVerifiedCount(0)
      toast.success(`✓ Reset ${data.deleted ?? 0} phone verification(s) — all numbers must re-verify`)
    } catch (error) {
      console.error("Error resetting verifications:", error)
      toast.error(error instanceof Error ? error.message : "Failed to reset verifications")
    } finally {
      setResettingVerifications(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldCheck className="h-5 w-5 text-primary" />
          Payment verification
        </CardTitle>
        <CardDescription>Phone-OTP gates for payment prompts. Turn ON during an attack.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Checkout Phone-OTP Gate */}
        <div className="flex flex-col gap-4 rounded-lg border-2 border-border bg-primary/10 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex-1">
            <p className="font-bold text-foreground">🔐 Require Phone OTP at Checkout</p>
            <p className="mt-2 text-sm text-foreground">
              {checkoutOtpEnabled
                ? "🔒 ON — every guest must enter an SMS code sent to their phone before they can place an order. Stops automated/bulk orders cold."
                : "Guest checkout is open (no OTP). Enable this during an attack to force phone verification. Note: each checkout sends one SMS (cost), so keep it OFF in normal operation."}
            </p>
          </div>
          <div className="flex min-w-fit items-center justify-end gap-4">
            <span className={`text-sm font-bold ${checkoutOtpEnabled ? "text-success" : "text-muted-foreground"}`}>
              {checkoutOtpEnabled ? "ON" : "OFF"}
            </span>
            <Switch
              checked={checkoutOtpEnabled}
              onCheckedChange={handleCheckoutOtpToggle}
              disabled={!loaded || savingCheckoutOtp}
              className="data-[state=checked]:bg-success"
            />
          </div>
        </div>

        {/* Wallet & Upgrade Payment Protection */}
        <div className="flex flex-col gap-4 rounded-lg border-2 border-border bg-primary/5 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex-1">
            <p className="font-bold text-foreground">💳 Protect Top-ups &amp; Upgrades</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Locks down the <b>order-free</b> payment paths — wallet top-ups &amp; dealer upgrades — which otherwise let
              any signed-in account open a hosted checkout and fire Mobile Money prompts at any number. Independent of the
              checkout OTP gate.
            </p>
            <p className="mt-2 text-sm text-foreground">
              {walletLockEnabled
                ? "🔒 ON — top-ups/upgrades require an OTP-verified payment number. Prompt-spam via these paths is blocked."
                : "OFF — no OTP required for top-ups/upgrades. Enable to require a verified payment number during an attack."}
            </p>
          </div>
          <div className="flex min-w-fit items-center justify-end gap-4">
            <span className={`text-sm font-bold ${walletLockEnabled ? "text-success" : "text-muted-foreground"}`}>
              {walletLockEnabled ? "ON" : "OFF"}
            </span>
            <Switch
              checked={walletLockEnabled}
              onCheckedChange={handleWalletLockToggle}
              disabled={!loaded || savingWalletLock}
              className="data-[state=checked]:bg-success"
            />
          </div>
        </div>

        {/* Reset Phone Verifications */}
        <div className="flex flex-col gap-4 rounded-lg border-2 border-destructive/40 bg-destructive/10 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex-1">
            <p className="font-bold text-foreground">
              📵 {verifiedCount === null ? "Verified numbers" : `${verifiedCount} number${verifiedCount === 1 ? "" : "s"} currently verified`}
            </p>
            <p className="mt-2 text-sm text-foreground">
              Clears every OTP-verified number, so all customers must re-verify their payment number once on their next
              order. Returning customers re-verify once (one SMS), then they&apos;re remembered again. Takes effect
              immediately — no deploy needed. This cannot be undone.
            </p>
          </div>
          <div className="flex min-w-fit items-center justify-end">
            <Button
              variant="destructive"
              onClick={handleResetVerifications}
              disabled={resettingVerifications}
              className="bg-destructive hover:bg-destructive/90"
            >
              {resettingVerifications ? "Resetting…" : "Reset all verifications"}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
