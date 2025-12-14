"use client"

import { Store, TrendingUp, Users } from "lucide-react"

export function Step5Shops() {
  return (
    <div className="space-y-6">
      <div className="flex justify-center mb-6">
        <div className="text-6xl">🏪</div>
      </div>

      <div className="space-y-4">
        <h3 className="text-2xl font-bold text-gray-900 text-center">
          Create Your Shop
        </h3>
        <p className="text-gray-600 text-center">
          Build a business on DATAGOD. Set your own prices and earn profits.
        </p>
      </div>

      <div className="space-y-4 mt-6">
        {/* Feature 1 */}
        <div className="flex gap-4 p-4 bg-orange-50 rounded-lg border border-orange-200">
          <div className="flex-shrink-0">
            <Store className="w-6 h-6 text-orange-600 mt-1" />
          </div>
          <div>
            <h4 className="font-semibold text-gray-900">Your Own Store</h4>
            <p className="text-sm text-gray-600 mt-1">
              Create branded shops and manage inventory. Each shop can have custom branding and settings.
            </p>
          </div>
        </div>

        {/* Feature 2 */}
        <div className="flex gap-4 p-4 bg-green-50 rounded-lg border border-green-200">
          <div className="flex-shrink-0">
            <TrendingUp className="w-6 h-6 text-green-600 mt-1" />
          </div>
          <div>
            <h4 className="font-semibold text-gray-900">Earn Profits</h4>
            <p className="text-sm text-gray-600 mt-1">
              Set markup prices and keep the difference. Your profit balance grows with every sale.
            </p>
          </div>
        </div>

        {/* Feature 3 */}
        <div className="flex gap-4 p-4 bg-blue-50 rounded-lg border border-blue-200">
          <div className="flex-shrink-0">
            <Users className="w-6 h-6 text-blue-600 mt-1" />
          </div>
          <div>
            <h4 className="font-semibold text-gray-900">Manage Customers</h4>
            <p className="text-sm text-gray-600 mt-1">
              Track customer orders, manage inventory, and build your business metrics dashboard.
            </p>
          </div>
        </div>
      </div>

      <div className="bg-gradient-to-r from-green-50 to-emerald-50 border border-green-200 rounded-lg p-4 space-y-3">
        <h4 className="font-semibold text-gray-900 text-sm">Shop Benefits:</h4>
        <ul className="space-y-2 text-sm text-gray-700">
          <li className="flex gap-2">
            <span className="text-green-600">✓</span> <span>Set your own profit margins</span>
          </li>
          <li className="flex gap-2">
            <span className="text-green-600">✓</span> <span>White-label storefront option</span>
          </li>
          <li className="flex gap-2">
            <span className="text-green-600">✓</span> <span>Detailed sales analytics</span>
          </li>
          <li className="flex gap-2">
            <span className="text-green-600">✓</span> <span>Automatic profit calculations</span>
          </li>
        </ul>
      </div>

      <div className="bg-orange-50 border border-orange-200 rounded-lg p-4 text-sm text-gray-700">
        <p className="font-semibold text-orange-900 mb-2">💡 Pro Tip:</p>
        <p>You can create multiple shops for different customer segments. Diversify your business!</p>
      </div>
    </div>
  )
}
