import { Badge } from "@/components/ui/badge"
import type { SupplierResult } from "@/lib/order-supplier"
import { supplierBadgeModel } from "@/lib/support-admin-client"
import { cn } from "@/lib/utils"

export function SupplierBadge({ supplier }: { supplier: SupplierResult }) {
  const { label, className } = supplierBadgeModel(supplier)
  return (
    <Badge variant="outline" className={cn("font-medium", className)}>
      {label}
    </Badge>
  )
}
