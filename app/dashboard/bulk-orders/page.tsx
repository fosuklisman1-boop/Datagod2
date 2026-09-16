"use client"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { BulkOrdersForm } from "@/components/bulk-orders-form"

export default function BulkOrdersPage() {
  return (
    <DashboardLayout>
      <div className="space-y-6 px-2 sm:px-4">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold text-foreground">Bulk Orders</h1>
          <p className="text-sm sm:text-base text-muted-foreground mt-1">Buy data for many recipients at once — paste numbers or upload a spreadsheet.</p>
        </div>
        <BulkOrdersForm />
      </div>
    </DashboardLayout>
  )
}
