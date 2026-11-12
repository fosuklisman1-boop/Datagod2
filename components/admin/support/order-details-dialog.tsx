"use client"

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import type { SupplierResult } from "@/lib/order-supplier"
import type { SupportOrder } from "@/lib/support-order"
import { SupplierBadge } from "./supplier-badge"

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—"
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString()
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-border py-2 last:border-0">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words text-right text-sm font-medium">{children}</dd>
    </div>
  )
}

export function OrderDetailsDialog({
  open,
  onOpenChange,
  order,
  supplier,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  order: SupportOrder | null
  supplier: SupplierResult
}) {
  const pkg = [order?.network, order?.size].filter(Boolean).join(" ")
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] w-[95vw] max-w-md overflow-y-auto sm:w-full">
        <DialogHeader>
          <DialogTitle>Order Details</DialogTitle>
          <DialogDescription>For resolving this complaint against the right order and supplier.</DialogDescription>
        </DialogHeader>
        {order ? (
          <dl>
            <Field label="Order reference">{order.reference ?? "—"}</Field>
            <Field label="Beneficiary number">{order.beneficiary ?? "—"}</Field>
            <Field label="Package">{pkg || "—"}</Field>
            <Field label="Order placed">{formatDateTime(order.created_at)}</Field>
            <Field label="Supplier">
              <SupplierBadge supplier={supplier} />
            </Field>
          </dl>
        ) : (
          <p className="text-sm text-muted-foreground">No order is linked to this complaint.</p>
        )}
      </DialogContent>
    </Dialog>
  )
}
