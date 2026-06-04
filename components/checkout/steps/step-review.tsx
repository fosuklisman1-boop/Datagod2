'use client'

import React from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Separator } from '@/components/ui/separator'
import { Loader2, CheckCircle2, Zap, Database, AlertCircle } from 'lucide-react'
import { CustomerData } from '@/contexts/OrderContext'

interface Package {
  id: string
  name: string
  amount: number
  package_type: 'airtime' | 'data'
  validity_days?: number
}

interface Network {
  id: string
  name: string
  slug: string
}

interface StepReviewProps {
  network?: Network
  package?: Package
  customer: CustomerData
  onConfirm: () => void
  onEdit: () => void
  onBack: () => void
  isLoading?: boolean
  error?: string
}

const formatAmount = (amount: number) => {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'GHS',
    minimumFractionDigits: 0,
  }).format(amount)
}

const maskPhone = (phone: string) => {
  if (!phone) return phone
  return `${phone.slice(0, 3)}****${phone.slice(-3)}`
}

const maskEmail = (email: string) => {
  if (!email) return email
  const [local, domain] = email.split('@')
  if (local.length <= 2) return email
  return `${local.charAt(0)}${'*'.repeat(local.length - 2)}${local.charAt(local.length - 1)}@${domain}`
}

export const StepReview: React.FC<StepReviewProps> = ({
  network,
  package: selectedPackage,
  customer,
  onConfirm,
  onEdit,
  onBack,
  isLoading = false,
  error,
}) => {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold mb-2">Review Your Order</h2>
        <p className="text-sm text-gray-600">Please verify all details before confirming</p>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {/* Order Summary */}
      <div className="space-y-3">
        <h3 className="text-lg font-semibold">Order Summary</h3>

        {/* Network */}
        <Card className="border-2">
          <CardContent className="pt-4 pb-4">
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-gray-600">Network</span>
                <Badge variant="default" className="text-xs">
                  {network?.name || 'Not selected'}
                </Badge>
              </div>
              {network && (
                <p className="text-xs text-gray-500">{network.slug.replace(/-/g, ' ').toUpperCase()}</p>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Package */}
        {selectedPackage && (
          <Card className="border-2">
            <CardContent className="pt-4 pb-4">
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    {selectedPackage.package_type === 'data' ? (
                      <Database className="h-4 w-4 text-blue-500" />
                    ) : (
                      <Zap className="h-4 w-4 text-yellow-500" />
                    )}
                    <span className="font-semibold">{selectedPackage.name}</span>
                  </div>
                  <Badge
                    variant="secondary"
                    className="text-xs capitalize"
                  >
                    {selectedPackage.package_type}
                  </Badge>
                </div>
                <Separator />
                <div className="flex items-center justify-between">
                  <span className="text-sm text-gray-600">Package Cost</span>
                  <span className="font-semibold text-primary">
                    {formatAmount(selectedPackage.amount)}
                  </span>
                </div>
                {selectedPackage.validity_days && (
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-gray-600">Validity</span>
                    <span>{selectedPackage.validity_days} days</span>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        )}
      </div>

      {/* Customer Details */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold">Your Details</h3>
          <Button
            variant="ghost"
            size="sm"
            onClick={onEdit}
            disabled={isLoading}
          >
            Edit
          </Button>
        </div>

        <Card className="border-2">
          <CardContent className="pt-4 pb-4">
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-xs font-medium text-gray-600 mb-1">Name</p>
                  <p className="text-sm font-semibold">{customer.name}</p>
                </div>
                <div>
                  <p className="text-xs font-medium text-gray-600 mb-1">Email</p>
                  <p className="text-sm font-mono text-gray-700">{maskEmail(customer.email)}</p>
                </div>
              </div>
              <div>
                <p className="text-xs font-medium text-gray-600 mb-1">Phone</p>
                <p className="text-sm font-mono text-gray-700">{maskPhone(customer.phone)}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Total */}
      <Card className="bg-primary/5 border-primary/20">
        <CardContent className="pt-4 pb-4">
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-gray-600">Package Cost</span>
              <span className="font-semibold">
                {selectedPackage ? formatAmount(selectedPackage.amount) : 'N/A'}
              </span>
            </div>
            <Separator className="my-2" />
            <div className="flex items-center justify-between">
              <span className="text-base font-semibold">Total Amount</span>
              <span className="text-2xl font-bold text-primary">
                {selectedPackage ? formatAmount(selectedPackage.amount) : 'N/A'}
              </span>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Info Alert */}
      <Alert className="border-blue-200 bg-blue-50">
        <CheckCircle2 className="h-4 w-4 text-blue-600" />
        <AlertDescription className="text-blue-800">
          After confirming, you'll be redirected to secure payment. No charges until payment is completed.
        </AlertDescription>
      </Alert>

      <div className="flex gap-2 pt-4">
        <Button variant="outline" onClick={onBack} disabled={isLoading}>
          Back
        </Button>
        <Button
          onClick={onConfirm}
          disabled={isLoading}
          className="ml-auto"
        >
          {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Confirm & Pay
        </Button>
      </div>
    </div>
  )
}
