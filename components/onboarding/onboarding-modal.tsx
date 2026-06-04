"use client"

import { useState, useEffect } from "react"
import { Dialog, DialogContent } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { ChevronLeft, ChevronRight, X } from "lucide-react"
import { TourOverlay } from "./tour-overlay"
import { useTourSpotlight } from "@/hooks/use-tour-spotlight"
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
  const [interactiveMode, setInteractiveMode] = useState(false)
  const [tourStep, setTourStep] = useState(0)
  const totalSteps = STEPS.length
  const { spotlight, highlightElement, clearSpotlight } = useTourSpotlight()

  // Define tour steps for wallet interactive mode
  const walletTourSteps = [
    {
      selector: '[data-tour="wallet-balance"]',
      message: "👈 This is your wallet balance. It shows how much money you have available to spend.",
      direction: "bottom" as const,
    },
    {
      selector: '[data-tour="wallet-topup"]',
      message: "👈 Click here to add funds to your wallet using different payment methods.",
      direction: "bottom" as const,
    },
    {
      selector: '[data-tour="transaction-history"]',
      message: "👈 View all your transactions here - credits, purchases, and withdrawals.",
      direction: "bottom" as const,
    },
  ]

  useEffect(() => {
    if (interactiveMode && tourStep < walletTourSteps.length) {
      const timer = setTimeout(() => {
        highlightElement(walletTourSteps[tourStep].selector)
      }, 500)
      return () => clearTimeout(timer)
    } else if (!interactiveMode) {
      clearSpotlight()
    }
  }, [interactiveMode, tourStep])

  const handleNext = () => {
    if (interactiveMode) {
      if (tourStep < walletTourSteps.length - 1) {
        setTourStep(tourStep + 1)
      } else {
        // End interactive mode
        setInteractiveMode(false)
        setTourStep(0)
      }
    } else {
      if (currentStep < totalSteps) {
        setCurrentStep(currentStep + 1)
      } else {
        onComplete()
      }
    }
  }

  const handlePrevious = () => {
    if (interactiveMode) {
      if (tourStep > 0) {
        setTourStep(tourStep - 1)
      } else {
        // Exit interactive mode
        setInteractiveMode(false)
        setTourStep(0)
      }
    } else {
      if (currentStep > 1) {
        setCurrentStep(currentStep - 1)
      }
    }
  }

  const handleSkip = () => {
    if (interactiveMode) {
      setInteractiveMode(false)
      setTourStep(0)
    } else {
      onSkip()
    }
  }

  const handleStartInteractiveWallet = () => {
    setInteractiveMode(true)
    setTourStep(0)
  }

  const progress = interactiveMode
    ? ((tourStep + 1) / walletTourSteps.length) * 100
    : (currentStep / totalSteps) * 100

  const renderStepContent = () => {
    if (interactiveMode) {
      return (
        <div className="space-y-4 text-center py-8">
          <div className="text-5xl">👆</div>
          <h3 className="text-xl font-bold text-gray-900">
            Interactive Wallet Guide
          </h3>
          <p className="text-gray-600">
            {walletTourSteps[tourStep]?.message || "Tour complete!"}
          </p>
          <p className="text-sm text-gray-500">
            Step {tourStep + 1} of {walletTourSteps.length}
          </p>
        </div>
      )
    }

    switch (currentStep) {
      case 1:
        return <Step1Welcome onNext={handleNext} onSkip={handleSkip} />
      case 2:
        return <Step2Wallet onStartInteractiveWallet={handleStartInteractiveWallet} />
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
    <>
      <TourOverlay
        spotlight={spotlight}
        message={
          interactiveMode && walletTourSteps[tourStep]
            ? walletTourSteps[tourStep].message
            : ""
        }
        direction={
          interactiveMode && walletTourSteps[tourStep]
            ? walletTourSteps[tourStep].direction
            : "bottom"
        }
      />

      <Dialog
        open={open}
        onOpenChange={(isOpen) => {
          if (!isOpen && currentStep > 1) {
            handleSkip()
          }
        }}
      >
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <div className="space-y-6">
            {/* Header */}
            <div className="flex items-center justify-between">
              <div className="flex-1">
                <h2 className="text-2xl font-bold text-gray-900">
                  {interactiveMode
                    ? "Wallet Interactive Guide"
                    : STEPS[currentStep - 1].title}
                </h2>
                <p className="text-sm text-gray-500 mt-1">
                  {interactiveMode
                    ? `Step ${tourStep + 1} of ${walletTourSteps.length}`
                    : `Step ${currentStep} of ${totalSteps}`}
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
                disabled={
                  interactiveMode ? tourStep === 0 : currentStep === 1
                }
                className="gap-2"
              >
                <ChevronLeft className="w-4 h-4" />
                Previous
              </Button>

              <div className="flex gap-2">
                <Button variant="ghost" onClick={handleSkip}>
                  {interactiveMode ? "Exit Tour" : "Skip"}
                </Button>
                <Button
                  onClick={handleNext}
                  className="gap-2 bg-gradient-to-r from-blue-600 to-purple-600"
                >
                  {interactiveMode
                    ? tourStep === walletTourSteps.length - 1
                      ? "End Tour"
                      : "Next"
                    : currentStep === totalSteps
                      ? "Get Started"
                      : "Next"}
                  <ChevronRight className="w-4 h-4" />
                </Button>
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
