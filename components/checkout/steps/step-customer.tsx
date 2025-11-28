'use client'

import React, { useState, useCallback } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Loader2, AlertCircle, CheckCircle2 } from 'lucide-react'
import { CustomerData } from '@/contexts/OrderContext'
import { useOrderValidation } from '@/hooks/useOrderValidation'

interface StepCustomerProps {
  formData: CustomerData
  onUpdate: (field: keyof CustomerData, value: string) => void
  onSubmit: () => void
  onBack: () => void
  isLoading?: boolean
  errors?: Partial<Record<keyof CustomerData, string>>
}

const getFieldIcon = (field: keyof CustomerData, isValid: boolean) => {
  if (!isValid) return null
  return <CheckCircle2 className="h-4 w-4 text-green-500" />
}

export const StepCustomer: React.FC<StepCustomerProps> = ({
  formData,
  onUpdate,
  onSubmit,
  onBack,
  isLoading = false,
  errors = {},
}) => {
  const { validateField } = useOrderValidation()
  const [touched, setTouched] = useState<Set<keyof CustomerData>>(new Set())

  const handleFieldChange = useCallback(
    (field: keyof CustomerData, value: string) => {
      onUpdate(field, value)
    },
    [onUpdate]
  )

  const handleBlur = useCallback((field: keyof CustomerData) => {
    setTouched((prev) => new Set(prev).add(field))
  }, [])

  const getFieldError = useCallback(
    (field: keyof CustomerData): string | null => {
      if (errors[field]) return errors[field] || null
      if (!touched.has(field)) return null
      return validateField(field, formData[field])
    },
    [errors, touched, validateField, formData]
  )

  const isFieldValid = useCallback(
    (field: keyof CustomerData): boolean => {
      return !getFieldError(field)
    },
    [getFieldError]
  )

  const nameError = getFieldError('name')
  const emailError = getFieldError('email')
  const phoneError = getFieldError('phone')
  const hasErrors = !!(nameError || emailError || phoneError)

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold mb-2">Your Details</h2>
        <p className="text-sm text-gray-600">Enter your information to complete the order</p>
      </div>

      {hasErrors && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>Please fix the errors below and try again</AlertDescription>
        </Alert>
      )}

      <div className="space-y-4">
        {/* Name Field */}
        <div className="space-y-2">
          <Label htmlFor="name" className="flex items-center justify-between">
            <span>Full Name</span>
            {isFieldValid('name') && touched.has('name') && (
              <span className="text-xs text-green-600 flex items-center gap-1">
                <CheckCircle2 className="h-3 w-3" />
                Valid
              </span>
            )}
          </Label>
          <div className="relative">
            <Input
              id="name"
              type="text"
              value={formData.name}
              onChange={(e) => handleFieldChange('name', e.target.value)}
              onBlur={() => handleBlur('name')}
              placeholder="e.g., John Doe"
              className={`pr-10 ${nameError ? 'border-red-500 focus:ring-red-500' : ''}`}
              disabled={isLoading}
            />
            {nameError && touched.has('name') && (
              <AlertCircle className="absolute right-3 top-3 h-4 w-4 text-red-500" />
            )}
          </div>
          {nameError && touched.has('name') && (
            <p className="text-xs text-red-600">{nameError}</p>
          )}
        </div>

        {/* Email Field */}
        <div className="space-y-2">
          <Label htmlFor="email" className="flex items-center justify-between">
            <span>Email Address</span>
            {isFieldValid('email') && touched.has('email') && (
              <span className="text-xs text-green-600 flex items-center gap-1">
                <CheckCircle2 className="h-3 w-3" />
                Valid
              </span>
            )}
          </Label>
          <div className="relative">
            <Input
              id="email"
              type="email"
              value={formData.email}
              onChange={(e) => handleFieldChange('email', e.target.value)}
              onBlur={() => handleBlur('email')}
              placeholder="e.g., john@example.com"
              className={`pr-10 ${emailError ? 'border-red-500 focus:ring-red-500' : ''}`}
              disabled={isLoading}
            />
            {emailError && touched.has('email') && (
              <AlertCircle className="absolute right-3 top-3 h-4 w-4 text-red-500" />
            )}
          </div>
          {emailError && touched.has('email') && (
            <p className="text-xs text-red-600">{emailError}</p>
          )}
        </div>

        {/* Phone Field */}
        <div className="space-y-2">
          <Label htmlFor="phone" className="flex items-center justify-between">
            <span>Phone Number</span>
            {isFieldValid('phone') && touched.has('phone') && (
              <span className="text-xs text-green-600 flex items-center gap-1">
                <CheckCircle2 className="h-3 w-3" />
                Valid
              </span>
            )}
          </Label>
          <div className="relative">
            <div className="absolute left-3 top-3 text-gray-500 text-sm font-medium">🇬🇭</div>
            <Input
              id="phone"
              type="tel"
              value={formData.phone}
              onChange={(e) => handleFieldChange('phone', e.target.value.replace(/\D/g, ''))}
              onBlur={() => handleBlur('phone')}
              placeholder="e.g., 0241234567"
              maxLength={10}
              className={`pl-10 pr-10 font-mono ${phoneError ? 'border-red-500 focus:ring-red-500' : ''}`}
              disabled={isLoading}
            />
            {phoneError && touched.has('phone') && (
              <AlertCircle className="absolute right-3 top-3 h-4 w-4 text-red-500" />
            )}
          </div>
          {phoneError && touched.has('phone') && (
            <p className="text-xs text-red-600">{phoneError}</p>
          )}
          {!phoneError && touched.has('phone') && (
            <p className="text-xs text-gray-500">Ghana phone format (10 digits)</p>
          )}
        </div>
      </div>

      {/* Helpful Info */}
      <Card className="bg-blue-50 border-blue-200">
        <CardContent className="pt-4">
          <div className="space-y-2 text-sm">
            <p className="font-medium text-blue-900">💡 Tips for entering your details:</p>
            <ul className="list-disc list-inside space-y-1 text-blue-800">
              <li>Full name as it appears on your ID</li>
              <li>Active email for order confirmation</li>
              <li>Ghana phone number (02 or 05 prefix)</li>
            </ul>
          </div>
        </CardContent>
      </Card>

      <div className="flex gap-2 pt-4">
        <Button variant="outline" onClick={onBack} disabled={isLoading}>
          Back
        </Button>
        <Button
          onClick={onSubmit}
          disabled={hasErrors || isLoading}
          className="ml-auto"
        >
          {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Review Order
        </Button>
      </div>
    </div>
  )
}
