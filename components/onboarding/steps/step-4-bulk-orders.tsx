"use client"

import { Upload, BarChart3, Zap } from "lucide-react"

export function Step4BulkOrders() {
  return (
    <div className="space-y-6">
      <div className="flex justify-center mb-6">
        <div className="text-6xl">📊</div>
      </div>

      <div className="space-y-4">
        <h3 className="text-2xl font-bold text-gray-900 text-center">
          Bulk Orders
        </h3>
        <p className="text-gray-600 text-center">
          Buy data for multiple numbers at once. Perfect for businesses and resellers.
        </p>
      </div>

      <div className="space-y-4 mt-6">
        {/* Feature 1 */}
        <div className="flex gap-4 p-4 bg-green-50 rounded-lg border border-green-200">
          <div className="flex-shrink-0">
            <Upload className="w-6 h-6 text-green-600 mt-1" />
          </div>
          <div>
            <h4 className="font-semibold text-gray-900">Upload CSV File</h4>
            <p className="text-sm text-gray-600 mt-1">
              Prepare a CSV with phone numbers, networks, and packages. Upload and we handle the rest.
            </p>
          </div>
        </div>

        {/* Feature 2 */}
        <div className="flex gap-4 p-4 bg-blue-50 rounded-lg border border-blue-200">
          <div className="flex-shrink-0">
            <BarChart3 className="w-6 h-6 text-blue-600 mt-1" />
          </div>
          <div>
            <h4 className="font-semibold text-gray-900">Track Progress</h4>
            <p className="text-sm text-gray-600 mt-1">
              Monitor order processing in real-time. See success rates and any failed orders instantly.
            </p>
          </div>
        </div>

        {/* Feature 3 */}
        <div className="flex gap-4 p-4 bg-purple-50 rounded-lg border border-purple-200">
          <div className="flex-shrink-0">
            <Zap className="w-6 h-6 text-purple-600 mt-1" />
          </div>
          <div>
            <h4 className="font-semibold text-gray-900">Fast Processing</h4>
            <p className="text-sm text-gray-600 mt-1">
              Orders are processed in batches for efficiency. Most complete within minutes, not hours.
            </p>
          </div>
        </div>
      </div>

      <div className="bg-gray-50 border border-gray-300 rounded-lg p-4 space-y-3">
        <h4 className="font-semibold text-gray-900 text-sm">CSV Format Example:</h4>
        <div className="bg-white p-3 rounded font-mono text-xs text-gray-700 overflow-x-auto">
          <div>phone,network,package</div>
          <div>0501234567,MTN,1GB</div>
          <div>0551234567,Vodafone,2GB</div>
          <div>0701234567,Telecel,500MB</div>
        </div>
      </div>

      <div className="bg-green-50 border border-green-200 rounded-lg p-4 text-sm text-gray-700">
        <p className="font-semibold text-green-900 mb-2">💡 Pro Tip:</p>
        <p>Bulk orders can save you up to 20% compared to individual purchases. Great for reselling!</p>
      </div>
    </div>
  )
}
