'use client'

import React from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { CheckCircle2, Circle, Loader2 } from 'lucide-react'

export type StepName = 'network' | 'package' | 'customer' | 'review' | 'confirmation'

interface Step {
  id: StepName
  label: string
  description?: string
}

interface ProgressIndicatorProps {
  currentStep: StepName
  steps?: Step[]
  progress?: number // 0-100
  isLoading?: boolean
}

const defaultSteps: Step[] = [
  { id: 'network', label: 'Network', description: 'Select network' },
  { id: 'package', label: 'Package', description: 'Choose package' },
  { id: 'customer', label: 'Details', description: 'Your information' },
  { id: 'review', label: 'Review', description: 'Confirm order' },
  { id: 'confirmation', label: 'Payment', description: 'Process payment' },
]

export const ProgressIndicator: React.FC<ProgressIndicatorProps> = ({
  currentStep,
  steps = defaultSteps,
  progress,
  isLoading = false,
}) => {
  const currentStepIndex = steps.findIndex((s) => s.id === currentStep)
  const progressPercent = progress ?? ((currentStepIndex + 1) / steps.length) * 100

  return (
    <Card className="border-0 bg-gradient-to-r from-primary/5 to-primary/10">
      <CardContent className="pt-6 pb-6">
        <div className="space-y-4">
          {/* Progress Bar */}
          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="font-semibold text-gray-700">
                Step {currentStepIndex + 1} of {steps.length}
              </span>
              <span className="text-gray-600">{Math.round(progressPercent)}%</span>
            </div>
            <div className="w-full h-2 bg-gray-200 rounded-full overflow-hidden">
              <div
                className="h-full bg-primary transition-all duration-300 ease-out"
                style={{ width: `${progressPercent}%` } as React.CSSProperties}
              ></div>
            </div>
          </div>

          {/* Steps */}
          <div className="grid grid-cols-5 gap-2 mt-6">
            {steps.map((step, index) => {
              const isCompleted = index < currentStepIndex
              const isCurrent = index === currentStepIndex
              const isFuture = index > currentStepIndex

              return (
                <div key={step.id} className="flex flex-col items-center">
                  {/* Step Circle */}
                  <div className="relative mb-2 w-10 h-10 flex items-center justify-center">
                    {isCompleted ? (
                      <div className="w-10 h-10 rounded-full bg-green-500 flex items-center justify-center">
                        <CheckCircle2 className="h-6 w-6 text-white" />
                      </div>
                    ) : isCurrent ? (
                      <div className="w-10 h-10 rounded-full bg-primary flex items-center justify-center">
                        {isLoading ? (
                          <Loader2 className="h-5 w-5 text-white animate-spin" />
                        ) : (
                          <Circle className="h-5 w-5 text-white fill-primary" />
                        )}
                      </div>
                    ) : (
                      <div className="w-10 h-10 rounded-full bg-gray-200 flex items-center justify-center">
                        <span className="text-xs font-semibold text-gray-600">{index + 1}</span>
                      </div>
                    )}

                    {/* Connector Line */}
                    {index < steps.length - 1 && (
                      <div
                        className={`absolute top-5 left-full w-2 h-0.5 transition-colors ${
                          isCompleted || isCurrent ? 'bg-primary' : 'bg-gray-200'
                        }`}
                        style={{ width: 'calc(100% - 2.5rem)' } as React.CSSProperties}
                      ></div>
                    )}
                  </div>

                  {/* Step Label */}
                  <div className="text-center">
                    <p
                      className={`text-xs font-semibold leading-tight ${
                        isCurrent
                          ? 'text-primary'
                          : isCompleted
                            ? 'text-green-600'
                            : 'text-gray-600'
                      }`}
                    >
                      {step.label}
                    </p>
                    {step.description && (
                      <p className="text-xs text-gray-500 mt-0.5 hidden sm:block">
                        {step.description}
                      </p>
                    )}
                  </div>
                </div>
              )
            })}
          </div>

          {/* Current Step Info */}
          {steps[currentStepIndex] && (
            <div className="pt-4 border-t bg-white rounded-lg p-3 mt-4">
              <p className="text-xs font-semibold text-gray-700">
                Current Step: <span className="text-primary">{steps[currentStepIndex].label}</span>
              </p>
              {steps[currentStepIndex].description && (
                <p className="text-xs text-gray-600 mt-1">
                  {steps[currentStepIndex].description}
                </p>
              )}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
