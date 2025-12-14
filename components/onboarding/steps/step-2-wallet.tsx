"use client"

import { Wallet, CreditCard, TrendingUp, Play } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useState } from "react"

interface Step2Props {
  onStartInteractiveWallet?: () => void
}

export function Step2Wallet({ onStartInteractiveWallet }: Step2Props) {
  const [showInteractive, setShowInteractive] = useState(false)

  const handleStartTour = () => {
    setShowInteractive(true)
    onStartInteractiveWallet?.()
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-center mb-6">
        <div className="text-6xl">💰</div>
      </div>

      <div className="space-y-4">
        <h3 className="text-2xl font-bold text-gray-900 text-center">
          Your Wallet
        </h3>
        <p className="text-gray-600 text-center">
          Your wallet is the heart of DATAGOD. Use it to store funds and purchase data packages.
        </p>
      </div>

      <div className="space-y-4 mt-6">
        {/* Feature 1 */}
        <div className="flex gap-4 p-4 bg-blue-50 rounded-lg border border-blue-200">
          <div className="flex-shrink-0">
            <Wallet className="w-6 h-6 text-blue-600 mt-1" />
          </div>
          <div>
            <h4 className="font-semibold text-gray-900">Check Your Balance</h4>
            <p className="text-sm text-gray-600 mt-1">
              View your current wallet balance on the dashboard. This is your available funds for purchases.
            </p>
          </div>
        </div>

        {/* Feature 2 */}
        <div className="flex gap-4 p-4 bg-green-50 rounded-lg border border-green-200">
          <div className="flex-shrink-0">
            <CreditCard className="w-6 h-6 text-green-600 mt-1" />
          </div>
          <div>
            <h4 className="font-semibold text-gray-900">Top Up Your Wallet</h4>
            <p className="text-sm text-gray-600 mt-1">
              Add funds using various payment methods. Your funds are credited instantly and securely.
            </p>
          </div>
        </div>

        {/* Feature 3 */}
        <div className="flex gap-4 p-4 bg-purple-50 rounded-lg border border-purple-200">
          <div className="flex-shrink-0">
            <TrendingUp className="w-6 h-6 text-purple-600 mt-1" />
          </div>
          <div>
            <h4 className="font-semibold text-gray-900">Track Transactions</h4>
            <p className="text-sm text-gray-600 mt-1">
              View your complete transaction history to monitor all credits, purchases, and withdrawals.
            </p>
          </div>
        </div>
      </div>

      <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4 text-sm text-gray-700">
        <p className="font-semibold text-yellow-900 mb-2">💡 Pro Tip:</p>
        <p>Keep your wallet funded to avoid delays when purchasing data packages. You can set up auto-reload if needed.</p>
      </div>

      {/* Interactive Wallet Button */}
      <Button
        onClick={handleStartTour}
        className="w-full bg-gradient-to-r from-blue-600 to-purple-600 gap-2 h-auto py-3"
        disabled={showInteractive}
      >
        <Play className="w-4 h-4" />
        <div className="text-left">
          <div className="font-semibold">Try Interactive Wallet Guide</div>
          <div className="text-xs opacity-90">Get live pointers on the dashboard</div>
        </div>
      </Button>
    </div>
  )
}
