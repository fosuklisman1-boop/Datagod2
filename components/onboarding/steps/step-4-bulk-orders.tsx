"use client"

import { Upload, BarChart3, Zap } from "lucide-react"

export function Step4BulkOrders() {
  return (
    <div className="space-y-6">
      <div className="flex justify-center mb-6">
        <div className="text-6xl">📊</div>
      </div>

      <div className="space-y-4">
        <h3 className="text-2xl font-bold text-foreground text-center">
          Bulk Orders
        </h3>
        <p className="text-muted-foreground text-center">
          Buy data for multiple numbers at once. Perfect for businesses and resellers.
        </p>
      </div>

      <div className="space-y-4 mt-6">
        {/* Feature 1 */}
        <div className="flex gap-4 p-4 bg-success/10 rounded-lg border border-border">
          <div className="flex-shrink-0">
            <Upload className="w-6 h-6 text-success mt-1" />
          </div>
          <div>
            <h4 className="font-semibold text-foreground">Upload CSV File</h4>
            <p className="text-sm text-muted-foreground mt-1">
              Prepare a CSV with phone numbers, networks, and packages. Upload and we handle the rest.
            </p>
          </div>
        </div>

        {/* Feature 2 */}
        <div className="flex gap-4 p-4 bg-primary/5 rounded-lg border border-primary/20">
          <div className="flex-shrink-0">
            <BarChart3 className="w-6 h-6 text-primary mt-1" />
          </div>
          <div>
            <h4 className="font-semibold text-foreground">Track Progress</h4>
            <p className="text-sm text-muted-foreground mt-1">
              Monitor order processing in real-time. See success rates and any failed orders instantly.
            </p>
          </div>
        </div>

        {/* Feature 3 */}
        <div className="flex gap-4 p-4 bg-primary/10 rounded-lg border border-border">
          <div className="flex-shrink-0">
            <Zap className="w-6 h-6 text-primary mt-1" />
          </div>
          <div>
            <h4 className="font-semibold text-foreground">Fast Processing</h4>
            <p className="text-sm text-muted-foreground mt-1">
              Orders are processed in batches for efficiency. Most complete within minutes, not hours.
            </p>
          </div>
        </div>
      </div>

      <div className="bg-muted/40 border border-border rounded-lg p-4 space-y-3">
        <h4 className="font-semibold text-foreground text-sm">CSV Format Example:</h4>
        <div className="bg-card p-3 rounded font-mono text-xs text-foreground overflow-x-auto">
          <div>phone,network,package</div>
          <div>0501234567,MTN,1GB</div>
          <div>0551234567,Vodafone,2GB</div>
          <div>0701234567,Telecel,500MB</div>
        </div>
      </div>

      <div className="bg-success/10 border border-border rounded-lg p-4 text-sm text-foreground">
        <p className="font-semibold text-success mb-2">💡 Pro Tip:</p>
        <p>Bulk orders can save you up to 20% compared to individual purchases. Great for reselling!</p>
      </div>
    </div>
  )
}
