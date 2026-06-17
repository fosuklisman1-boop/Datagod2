"use client"

import { Store, TrendingUp, Users } from "lucide-react"

export function Step5Shops() {
  return (
    <div className="space-y-6">
      <div className="flex justify-center mb-6">
        <div className="text-6xl">🏪</div>
      </div>

      <div className="space-y-4">
        <h3 className="text-2xl font-bold text-foreground text-center">
          Create Your Shop
        </h3>
        <p className="text-muted-foreground text-center">
          Build a business on DATAGOD. Set your own prices and earn profits.
        </p>
      </div>

      <div className="space-y-4 mt-6">
        {/* Feature 1 */}
        <div className="flex gap-4 p-4 bg-warning/10 rounded-lg border border-border">
          <div className="flex-shrink-0">
            <Store className="w-6 h-6 text-warning mt-1" />
          </div>
          <div>
            <h4 className="font-semibold text-foreground">Your Own Store</h4>
            <p className="text-sm text-muted-foreground mt-1">
              Create branded shops and manage inventory. Each shop can have custom branding and settings.
            </p>
          </div>
        </div>

        {/* Feature 2 */}
        <div className="flex gap-4 p-4 bg-success/10 rounded-lg border border-border">
          <div className="flex-shrink-0">
            <TrendingUp className="w-6 h-6 text-success mt-1" />
          </div>
          <div>
            <h4 className="font-semibold text-foreground">Earn Profits</h4>
            <p className="text-sm text-muted-foreground mt-1">
              Set markup prices and keep the difference. Your profit balance grows with every sale.
            </p>
          </div>
        </div>

        {/* Feature 3 */}
        <div className="flex gap-4 p-4 bg-primary/5 rounded-lg border border-primary/20">
          <div className="flex-shrink-0">
            <Users className="w-6 h-6 text-primary mt-1" />
          </div>
          <div>
            <h4 className="font-semibold text-foreground">Manage Customers</h4>
            <p className="text-sm text-muted-foreground mt-1">
              Track customer orders, manage inventory, and build your business metrics dashboard.
            </p>
          </div>
        </div>
      </div>

      <div className="bg-card border border-border rounded-lg p-4 space-y-3">
        <h4 className="font-semibold text-foreground text-sm">Shop Benefits:</h4>
        <ul className="space-y-2 text-sm text-foreground">
          <li className="flex gap-2">
            <span className="text-success">✓</span> <span>Set your own profit margins</span>
          </li>
          <li className="flex gap-2">
            <span className="text-success">✓</span> <span>White-label storefront option</span>
          </li>
          <li className="flex gap-2">
            <span className="text-success">✓</span> <span>Detailed sales analytics</span>
          </li>
          <li className="flex gap-2">
            <span className="text-success">✓</span> <span>Automatic profit calculations</span>
          </li>
        </ul>
      </div>

      <div className="bg-warning/10 border border-border rounded-lg p-4 text-sm text-foreground">
        <p className="font-semibold text-warning mb-2">💡 Pro Tip:</p>
        <p>You can create multiple shops for different customer segments. Diversify your business!</p>
      </div>
    </div>
  )
}
