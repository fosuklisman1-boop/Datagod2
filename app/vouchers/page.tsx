"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { VoucherLookup } from "@/components/shop/VoucherLookup"

export default function VouchersPage() {
  return (
    <div className="min-h-screen flex items-start justify-center bg-background px-4 pt-16 pb-12">
      <div className="w-full max-w-md space-y-6">
        <div className="text-center space-y-1">
          <h1 className="text-2xl font-bold">Retrieve Vouchers</h1>
          <p className="text-sm text-muted-foreground">
            Look up your results checker PINs and resend them by SMS.
          </p>
        </div>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Find your order</CardTitle>
          </CardHeader>
          <CardContent>
            <VoucherLookup />
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
