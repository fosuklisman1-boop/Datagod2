"use client"

import { useState } from "react"
import { Dialog, DialogContent } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { ChevronLeft, ChevronRight, X } from "lucide-react"
import { Step1Welcome } from "./steps/step-1-welcome"
import { Step2Wallet } from "./steps/step-2-wallet"
import { Step3BuyData } from "./steps/step-3-buy-data"
import { Step4BulkOrders } from "./steps/step-4-bulk-orders"
import { Step5Shops } from "./steps/step-5-shops"
import { Step6Support } from "./steps/step-6-support"
import { Step7Done } from "./steps/step-7-done"

const STEPS = [
  { id: 1, title: "Welcome" },
  { id: 2, title: "Wallet" },
  { id: 3, title: "Buy Data" },
  { id: 4, title: "Bulk Orders" },
  { id: 5, title: "Shops" },
  { id: 6, title: "Support" },
  { id: 7, title: "All Set" },
]

interface OnboardingModalProps {
  open: boolean
  onComplete: () => void
  onSkip: () => void
}

export function OnboardingModal({ open, onComplete, onSkip }: OnboardingModalProps) {
  const [currentStep, setCurrentStep] = useState(1)
  const totalSteps = STEPS.length

  const handleNext = () => {
    if (currentStep < totalSteps) {
      setCurrentStep(currentStep + 1)
    } else {
      onComplete()
    }
  }

  const handlePrevious = () => {
    if (currentStep > 1) {
      setCurrentStep(currentStep - 1)
    }
  }

  const handleSkip = () => {
    onSkip()
  }

  const progress = (currentStep / totalSteps) * 100

  const renderStepContent = () => {
    switch (currentStep) {
      case 1:
        return <Step1Welcome onNext={handleNext} onSkip={handleSkip} />
      case 2:
        return <Step2Wallet />
      case 3:
        return <Step3BuyData />
      case 4:
        return <Step4BulkOrders />
      case 5:
        return <Step5Shops />
      case 6:
        return <Step6Support />
      case 7:
        return <Step7Done onComplete={onComplete} />
      default:
        return null
    }
  }

  return (
    <Dialog open={open} onOpenChange={(isOpen) => {
      if (!isOpen && currentStep > 1) {
        // Only allow closing after showing first step
        handleSkip()
      }
    }}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <div className="space-y-6">
          {/* Header */}
          <div className="flex items-center justify-between">
            <div className="flex-1">
              <h2 className="text-2xl font-bold text-gray-900">
                {STEPS[currentStep - 1].title}
              </h2>
              <p className="text-sm text-gray-500 mt-1">
                Step {currentStep} of {totalSteps}
              </p>
            </div>
            <button
              onClick={handleSkip}
              className="text-gray-400 hover:text-gray-600 transition"
              aria-label="Close onboarding"
            >
              <X className="w-6 h-6" />
            </button>
          </div>

          {/* Progress Bar */}
          <Progress value={progress} className="h-2" />

          {/* Step Content */}
          <div className="min-h-[300px] py-6">
            {renderStepContent()}
          </div>

          {/* Footer Navigation */}
          <div className="flex items-center justify-between pt-6 border-t border-gray-200">
            <Button
              variant="outline"
              onClick={handlePrevious}
              disabled={currentStep === 1}
              className="gap-2"
            >
              <ChevronLeft className="w-4 h-4" />
              Previous
            </Button>

            <div className="flex gap-2">
              <Button
                variant="ghost"
                onClick={handleSkip}
              >
                Skip
              </Button>
              <Button
                onClick={handleNext}
                className="gap-2 bg-gradient-to-r from-blue-600 to-purple-600"
              >
                {currentStep === totalSteps ? "Get Started" : "Next"}
                <ChevronRight className="w-4 h-4" />
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
