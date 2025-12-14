"use client"

import { useState, useEffect } from "react"
import { useRouter } from "next/navigation"
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { AlertCircle, Wallet } from "lucide-react"
import { useAuth } from "@/hooks/use-auth"
import { supabase } from "@/lib/supabase"

interface WalletOnboardingModalProps {
  open: boolean
  onComplete: () => void
}

export function WalletOnboardingModal({ open, onComplete }: WalletOnboardingModalProps) {
  const router = useRouter()
  const { user } = useAuth()
  const [walletBalance, setWalletBalance] = useState<number | null>(null)

  useEffect(() => {
    // Fetch wallet balance when modal opens
    if (open) {
      const fetchBalance = async () => {
        try {
          const { data, error } = await supabase
            .from("wallets")
            .select("balance")
            .eq("user_id", user?.id)
            .maybeSingle()

          if (error) {
            console.error("Error fetching wallet balance:", error)
            setWalletBalance(0)
            return
          }

          setWalletBalance(data?.balance || 0)
        } catch (err) {
          console.error("Error fetching wallet balance:", err)
          setWalletBalance(0)
        }
      }
      fetchBalance()
    }
  }, [open, user?.id])

  const handleTopUp = () => {
    onComplete()
    router.push("/dashboard/wallet")
  }

  return (
    <Dialog open={open} onOpenChange={(isOpen) => {
      if (!isOpen) {
        onComplete()
      }
    }}>
      <DialogContent className="sm:max-w-md">
        <DialogTitle className="flex items-center gap-2">
          <AlertCircle className="w-5 h-5 text-orange-600" />
          Top Up Your Wallet
        </DialogTitle>
        <DialogDescription>
          Your wallet balance is low. Add funds to start buying data packages.
        </DialogDescription>

        <div className="space-y-6 py-6">
          {/* Current Balance */}
          <div className="bg-gradient-to-br from-green-50 to-emerald-50 border border-green-200 rounded-lg p-6">
            <p className="text-sm text-gray-600 mb-2">Current Balance</p>
            <div className="flex items-center gap-3">
              <Wallet className="w-8 h-8 text-green-600" />
              <div className="text-3xl font-bold text-green-600">
                GHS {walletBalance !== null ? walletBalance.toFixed(2) : '0.00'}
              </div>
            </div>
          </div>

          {/* Info Message */}
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
            <p className="text-sm text-gray-700">
              You need a minimum balance to purchase data packages. Click the button below to add funds to your wallet using various payment methods.
            </p>
          </div>

          {/* Action Buttons */}
          <div className="space-y-3">
            <Button
              onClick={handleTopUp}
              size="lg"
              className="w-full bg-gradient-to-r from-green-600 to-emerald-600 text-white"
            >
              Go to Wallet
            </Button>
            <Button
              onClick={onComplete}
              variant="outline"
              size="lg"
              className="w-full"
            >
              Remind Me Later
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
