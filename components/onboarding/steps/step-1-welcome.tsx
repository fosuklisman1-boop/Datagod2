"use client"

import { Button } from "@/components/ui/button"
import { ArrowRight } from "lucide-react"

interface Step1Props {
  onNext: () => void
  onSkip: () => void
}

export function Step1Welcome({ onNext, onSkip }: Step1Props) {
  return (
    <div className="space-y-6 text-center py-6">
      <div className="flex justify-center mb-6">
        <div className="text-6xl">👋</div>
      </div>

      <div className="space-y-3">
        <h3 className="text-3xl font-bold text-gray-900">
          Welcome to DATAGOD!
        </h3>
        <p className="text-lg text-gray-600 max-w-lg mx-auto">
          Your complete data hub solution for buying data packages, managing your wallet, and tracking orders all in one place.
        </p>
      </div>

      <div className="bg-gradient-to-br from-blue-50 to-purple-50 rounded-lg p-6 space-y-3 text-left">
        <h4 className="font-semibold text-gray-900">What you'll learn:</h4>
        <ul className="space-y-2 text-sm text-gray-700">
          <li className="flex gap-2">
            <span>💰</span> <span>How to manage your wallet</span>
          </li>
          <li className="flex gap-2">
            <span>📦</span> <span>Purchasing data packages</span>
          </li>
          <li className="flex gap-2">
            <span>📊</span> <span>Bulk order features</span>
          </li>
          <li className="flex gap-2">
            <span>🏪</span> <span>Creating and managing shops</span>
          </li>
          <li className="flex gap-2">
            <span>💬</span> <span>How to get support</span>
          </li>
        </ul>
      </div>

      <div className="space-y-3 pt-4">
        <Button
          onClick={onNext}
          size="lg"
          className="w-full bg-gradient-to-r from-blue-600 to-purple-600 gap-2"
        >
          Let's Get Started
          <ArrowRight className="w-4 h-4" />
        </Button>
        <Button
          onClick={onSkip}
          variant="outline"
          size="lg"
          className="w-full"
        >
          Skip Tour
        </Button>
      </div>
    </div>
  )
}
