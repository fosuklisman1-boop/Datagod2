'use client'

import React, { useEffect, useState, useCallback } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { Card, CardContent } from '@/components/ui/card'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Loader2, AlertCircle, ArrowLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'
import Link from 'next/link'
import { toast } from 'sonner'

import { useOrderContext } from '@/contexts/OrderContext'
import { ProgressIndicator } from '@/components/checkout/progress-indicator'
import { StepReview } from '@/components/checkout/steps/step-review'
import { StepConfirmation } from '@/components/checkout/steps/step-confirmation'
import { ErrorRecovery, RecoveryOption } from '@/components/checkout/error-recovery'

interface ShopData {
  id: string
  name: string
  slug: string
  networks: any[]
  packages: any[]
}

type Step = 'review' | 'confirmation'

export default function CheckoutPage() {
  const params = useParams()
  const router = useRouter()
  const slug = params.slug as string

  const {
    selectedNetwork,
    selectedPackage,
    customerData,
    order,
    error,
    state: orderState,
    isProcessing,
    submitOrder,
    retryOrder,
    resetFlow,
    setShop,
  } = useOrderContext()

  const [currentStep, setCurrentStep] = useState<Step>('review')
  const [shopData, setShopData] = useState<ShopData | null>(null)
  const [isLoadingShop, setIsLoadingShop] = useState(true)
  const [shopError, setShopError] = useState<string | null>(null)

  // Update step based on order state
  useEffect(() => {
    if (orderState === 'ORDER_CREATED') setCurrentStep('confirmation')
    else setCurrentStep('review')
  }, [orderState])

  // Load shop data
  useEffect(() => {
    const loadShop = async () => {
      try {
        setIsLoadingShop(true)
        const response = await fetch(`/api/shops/${slug}`)
        if (!response.ok) throw new Error('Failed to load shop')
        const data = await response.json()
        setShopData(data)
        setShop(data)
      } catch (error) {
        setShopError(error instanceof Error ? error.message : 'Failed to load shop')
      } finally {
        setIsLoadingShop(false)
      }
    }

    if (slug) {
      loadShop()
    }
  }, [slug, setShop])



  // Build recovery options based on error state
  const getRecoveryOptions = (): RecoveryOption[] => {
    return []
  }

  // Loading state
  if (isLoadingShop) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <Loader2 className="h-12 w-12 text-primary animate-spin mx-auto mb-4" />
          <p className="text-gray-600">Loading shop...</p>
        </div>
      </div>
    )
  }

  // Shop error state
  if (shopError || !shopData) {
    return (
      <div className="min-h-screen bg-gray-50 p-4">
        <div className="max-w-2xl mx-auto pt-8">
          <Link href={`/shop/${slug}`}>
            <Button variant="ghost" className="mb-6">
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back to Shop
            </Button>
          </Link>

          <Alert variant="destructive" className="mb-6">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              {shopError || 'Failed to load shop. Please try again.'}
            </AlertDescription>
          </Alert>

          <Card>
            <CardContent className="pt-12 pb-12 text-center">
              <p className="text-gray-600 mb-4">Unable to proceed with checkout</p>
              <Link href={`/shop/${slug}`}>
                <Button>Return to Shop</Button>
              </Link>
            </CardContent>
          </Card>
        </div>
      </div>
    )
  }

  // Main checkout UI
  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-4xl mx-auto p-4 py-8">
        {/* Header */}
        <div className="mb-8">
          <Link href={`/shop/${slug}`}>
            <Button variant="ghost" className="mb-4">
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back to {shopData.name}
            </Button>
          </Link>
          <h1 className="text-3xl font-bold text-gray-900">{shopData.name} Checkout</h1>
          <p className="text-gray-600 mt-2">Complete your order in a few simple steps</p>
        </div>

        {/* Progress Indicator */}
        <div className="mb-8">
          <ProgressIndicator
            currentStep={currentStep}
            steps={[
              { id: 'review', label: 'Review', description: 'Confirm order' },
              { id: 'confirmation', label: 'Confirmation', description: 'Complete' },
            ]}
            progress={currentStep === 'review' ? 50 : 100}
            isLoading={isProcessing}
          />
        </div>

        {/* Main Content */}
        <Card>
          <CardContent className="pt-8 pb-8">
            {/* Error State */}
            {error && (
              <ErrorRecovery
                title={error.message || 'Checkout Error'}
                message="An error occurred during checkout. Please try again."
                error={error.code}
                recoveryOptions={[
                  {
                    id: 'retry',
                    label: 'Try Again',
                    description: 'Retry the payment',
                    action: () => retryOrder(),
                    isPrimary: true,
                  },
                  {
                    id: 'back-shop',
                    label: 'Back to Shop',
                    description: 'Return to the shop',
                    action: () => router.push(`/shop/${slug}`),
                  },
                ]}
              />
            )}

            {/* Review Step */}
            {currentStep === 'review' && !error && (
              <StepReview
                network={shopData?.networks.find(
                  (n: any) =>
                    n.id === selectedNetwork ||
                    n.slug === selectedNetwork ||
                    n.name === selectedNetwork
                )}
                package={selectedPackage ? {
                  id: selectedPackage.id,
                  name: selectedPackage.description,
                  amount: selectedPackage.price,
                  package_type: selectedPackage.size ? 'data' : 'airtime',
                } : undefined}
                customer={customerData}
                onConfirm={() => {
                  // Order should already be submitted from landing page
                  // Just proceed to confirmation
                }}
                onEdit={() => router.push(`/shop/${slug}`)}
                onBack={() => router.push(`/shop/${slug}`)}
                isLoading={isProcessing}
              />
            )}

            {/* Confirmation Step */}
            {currentStep === 'confirmation' && !error && order && (
              <StepConfirmation
                order={{
                  id: order.id,
                  reference: order.id,
                  created_at: order.created_at,
                  customer: {
                    name: order.customer_name,
                    phone: order.customer_phone,
                    email: order.customer_email,
                  },
                  package: {
                    name: selectedPackage?.description || 'Package',
                    amount: selectedPackage?.price || 0,
                    type: selectedPackage?.size ? 'data' : 'airtime',
                  },
                }}
                isProcessing={isProcessing}
                onProceedToPayment={() => {
                  router.push(`/shop/${slug}/order-confirmation/${order.id}`)
                }}
                onBackToShop={() => router.push(`/shop/${slug}`)}
                shopSlug={slug}
              />
            )}
          </CardContent>
        </Card>

        {/* Footer Info */}
        <div className="mt-8 text-center text-sm text-gray-600">
          <p>Your information is secure and encrypted</p>
          <p className="mt-2">
            Questions? <a href="#" className="text-primary hover:underline">Contact Support</a>
          </p>
        </div>
      </div>
    </div>
  )
}
