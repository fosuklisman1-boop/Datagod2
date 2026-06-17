"use client"

import { ShoppingCart, Zap, Smartphone } from "lucide-react"

export function Step3BuyData() {
  return (
    <div className="space-y-6">
      <div className="flex justify-center mb-6">
        <div className="text-6xl">📦</div>
      </div>

      <div className="space-y-4">
        <h3 className="text-2xl font-bold text-foreground text-center">
          Buy Data Packages
        </h3>
        <p className="text-muted-foreground text-center">
          Purchase data packages from all major networks in Ghana with instant delivery.
        </p>
      </div>

      <div className="space-y-4 mt-6">
        {/* Step 1 */}
        <div className="flex gap-4 p-4 bg-primary/5 rounded-lg border border-primary/20">
          <div className="flex-shrink-0 flex items-center justify-center w-8 h-8 bg-primary text-white rounded-full font-semibold text-sm">
            1
          </div>
          <div>
            <h4 className="font-semibold text-foreground">Select Network</h4>
            <p className="text-sm text-muted-foreground mt-1">
              Choose from MTN, Telecel, Vodafone, AT, and other networks available in Ghana.
            </p>
          </div>
        </div>

        {/* Step 2 */}
        <div className="flex gap-4 p-4 bg-success/10 rounded-lg border border-border">
          <div className="flex-shrink-0 flex items-center justify-center w-8 h-8 bg-success text-primary-foreground rounded-full font-semibold text-sm">
            2
          </div>
          <div>
            <h4 className="font-semibold text-foreground">Choose Package</h4>
            <p className="text-sm text-muted-foreground mt-1">
              Pick your preferred data size and validity period. Prices are shown upfront with no hidden charges.
            </p>
          </div>
        </div>

        {/* Step 3 */}
        <div className="flex gap-4 p-4 bg-primary rounded-lg border border-border">
          <div className="flex-shrink-0 flex items-center justify-center w-8 h-8 bg-primary text-white rounded-full font-semibold text-sm">
            3
          </div>
          <div>
            <h4 className="font-semibold text-foreground">Complete Purchase</h4>
            <p className="text-sm text-muted-foreground mt-1">
              Pay from your wallet and receive your data instantly. Track your order status in real-time.
            </p>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3 mt-6">
        <div className="text-center p-3 bg-muted/40 rounded-lg">
          <Zap className="w-6 h-6 text-warning mx-auto mb-2" />
          <p className="text-xs font-semibold text-foreground">Instant</p>
          <p className="text-xs text-muted-foreground">Delivery</p>
        </div>
        <div className="text-center p-3 bg-muted/40 rounded-lg">
          <ShoppingCart className="w-6 h-6 text-primary mx-auto mb-2" />
          <p className="text-xs font-semibold text-foreground">Multiple</p>
          <p className="text-xs text-muted-foreground">Networks</p>
        </div>
        <div className="text-center p-3 bg-muted/40 rounded-lg">
          <Smartphone className="w-6 h-6 text-success mx-auto mb-2" />
          <p className="text-xs font-semibold text-foreground">Any</p>
          <p className="text-xs text-muted-foreground">Number</p>
        </div>
      </div>

      <div className="bg-primary/5 border border-primary/20 rounded-lg p-4 text-sm text-foreground">
        <p className="font-semibold text-blue-900 mb-2">💡 Pro Tip:</p>
        <p>Bookmark your favorite networks for quick access. You can also save frequently used numbers.</p>
      </div>
    </div>
  )
}
