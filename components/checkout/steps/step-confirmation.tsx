'use client'

import React, { useEffect } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { CheckCircle2, Loader2, ArrowRight } from 'lucide-react'
import Link from 'next/link'

interface OrderData {
  id: string
  reference: string
  created_at: string
  customer: {
    name: string
    phone: string
    email: string
  }
  package: {
    name: string
    amount: number
    type: string
  }
}

interface StepConfirmationProps {
  order?: OrderData
  isProcessing?: boolean
  onProceedToPayment?: () => void
  onBackToShop?: () => void
  shopSlug?: string
}

const formatAmount = (amount: number) => {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'GHS',
    minimumFractionDigits: 0,
  }).format(amount)
}

export const StepConfirmation: React.FC<StepConfirmationProps> = ({
  order,
  isProcessing = false,
  onProceedToPayment,
  onBackToShop,
  shopSlug,
}) => {
  return (
    <div className="space-y-6">
      {/* Success Banner */}
      <div className="text-center space-y-4">
        <div className="flex justify-center">
          <div className="relative">
            <div className="absolute inset-0 bg-green-100 rounded-full animate-pulse"></div>
            <CheckCircle2 className="h-16 w-16 text-green-600 relative" />
          </div>
        </div>
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Order Created Successfully!</h2>
          <p className="text-gray-600 mt-2">Your order has been created and is awaiting payment</p>
        </div>
      </div>

      {/* Order Details */}
      {order && (
        <Card className="border-2 border-green-200 bg-green-50/50">
          <CardContent className="pt-6 pb-6">
            <div className="space-y-4">
              {/* Order ID */}
              <div>
                <p className="text-xs font-medium text-gray-600 mb-1">Order Number</p>
                <p className="text-lg font-bold text-gray-900 font-mono">{order.id}</p>
              </div>

              <Separator />

              {/* Package Info */}
              <div>
                <p className="text-xs font-medium text-gray-600 mb-2">Package Details</p>
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-sm">{order.package.name}</span>
                    <Badge variant="secondary" className="capitalize text-xs">
                      {order.package.type}
                    </Badge>
                  </div>
                  <div className="flex items-center justify-between pt-2 border-t">
                    <span className="text-sm font-medium">Amount to Pay</span>
                    <span className="text-lg font-bold text-green-600">
                      {formatAmount(order.package.amount)}
                    </span>
                  </div>
                </div>
              </div>

              <Separator />

              {/* Customer Info */}
              <div>
                <p className="text-xs font-medium text-gray-600 mb-2">Delivery To</p>
                <div className="space-y-1 text-sm">
                  <p className="font-semibold">{order.customer.name}</p>
                  <p className="text-gray-600">{order.customer.phone}</p>
                  <p className="text-gray-600">{order.customer.email}</p>
                </div>
              </div>

              <Separator />

              {/* Created Time */}
              <div>
                <p className="text-xs font-medium text-gray-600 mb-1">Created At</p>
                <p className="text-sm text-gray-700">
                  {new Date(order.created_at).toLocaleString('en-US', {
                    year: 'numeric',
                    month: 'short',
                    day: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Important Info */}
      <Card className="border-blue-200 bg-blue-50">
        <CardContent className="pt-4 pb-4">
          <div className="space-y-3">
            <div>
              <p className="font-semibold text-blue-900 mb-2">📋 What Happens Next?</p>
              <ol className="space-y-2 text-sm text-blue-800">
                <li className="flex gap-2">
                  <span className="font-bold">1.</span>
                  <span>Click "Proceed to Payment" below</span>
                </li>
                <li className="flex gap-2">
                  <span className="font-bold">2.</span>
                  <span>Complete payment on Paystack</span>
                </li>
                <li className="flex gap-2">
                  <span className="font-bold">3.</span>
                  <span>Get confirmation & receive your airtime/data</span>
                </li>
              </ol>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Action Buttons */}
      <div className="flex flex-col gap-3 pt-4">
        <Button
          onClick={onProceedToPayment}
          disabled={isProcessing}
          size="lg"
          className="w-full"
        >
          {isProcessing ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Processing...
            </>
          ) : (
            <>
              Proceed to Payment
              <ArrowRight className="ml-2 h-4 w-4" />
            </>
          )}
        </Button>

        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={onBackToShop}
            disabled={isProcessing}
            className="flex-1"
          >
            Back to Shop
          </Button>
          {shopSlug && (
            <Link href={`/shop/${shopSlug}`} className="flex-1">
              <Button variant="outline" className="w-full">
                View Shop
              </Button>
            </Link>
          )}
        </div>
      </div>

      {/* Help Section */}
      <Card className="border-gray-200 bg-gray-50">
        <CardContent className="pt-4 pb-4">
          <div className="space-y-2 text-sm text-gray-600">
            <p className="font-semibold text-gray-900">Need Help?</p>
            <ul className="space-y-1 text-xs">
              <li>• Payment issues? Check your internet connection and try again</li>
              <li>• Lost your order number? Check your email confirmation</li>
              <li>• Have questions? Contact our support team</li>
            </ul>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
