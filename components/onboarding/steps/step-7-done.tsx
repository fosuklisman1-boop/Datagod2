"use client"

import { Button } from "@/components/ui/button"
import { CheckCircle, ArrowRight } from "lucide-react"

interface Step7Props {
  onComplete: () => void
}

export function Step7Done({ onComplete }: Step7Props) {
  return (
    <div className="space-y-6 text-center py-6">
      <div className="flex justify-center mb-6">
        <div className="relative">
          <div className="text-6xl">🎉</div>
          <div className="absolute -bottom-2 -right-2">
            <CheckCircle className="w-8 h-8 text-green-500 fill-green-500" />
          </div>
        </div>
      </div>

      <div className="space-y-3">
        <h3 className="text-3xl font-bold text-foreground">
          You're All Set!
        </h3>
        <p className="text-lg text-muted-foreground max-w-lg mx-auto">
          You now know the essentials of DATAGOD. Time to explore and start buying data!
        </p>
      </div>

      <div className="bg-card rounded-lg p-6 space-y-4 text-left">
        <h4 className="font-semibold text-foreground text-center">Quick Next Steps:</h4>
        <div className="space-y-3">
          <div className="flex gap-3">
            <span className="flex-shrink-0 flex items-center justify-center w-6 h-6 bg-green-500 text-white rounded-full text-sm font-bold">
              1
            </span>
            <div>
              <p className="font-semibold text-foreground">Fund Your Wallet</p>
              <p className="text-sm text-muted-foreground">Top up with your preferred payment method</p>
            </div>
          </div>
          <div className="flex gap-3">
            <span className="flex-shrink-0 flex items-center justify-center w-6 h-6 bg-green-500 text-white rounded-full text-sm font-bold">
              2
            </span>
            <div>
              <p className="font-semibold text-foreground">Buy Your First Data</p>
              <p className="text-sm text-muted-foreground">Select a network and package to purchase</p>
            </div>
          </div>
          <div className="flex gap-3">
            <span className="flex-shrink-0 flex items-center justify-center w-6 h-6 bg-green-500 text-white rounded-full text-sm font-bold">
              3
            </span>
            <div>
              <p className="font-semibold text-foreground">Explore Advanced Features</p>
              <p className="text-sm text-muted-foreground">Try bulk orders or create your own shop</p>
            </div>
          </div>
        </div>
      </div>

      <div className="space-y-3 pt-4">
        <p className="text-sm text-muted-foreground">
          Questions? Our support team is always ready to help via WhatsApp or email.
        </p>
        <Button
          onClick={onComplete}
          size="lg"
          className="w-full bg-gradient-to-r from-green-600 to-emerald-600 gap-2"
        >
          Go to Dashboard
          <ArrowRight className="w-4 h-4" />
        </Button>
      </div>

      <div className="text-xs text-muted-foreground pt-2">
        You can revisit this tour anytime from settings
      </div>
    </div>
  )
}
