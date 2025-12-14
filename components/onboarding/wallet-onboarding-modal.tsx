"use client"

import { useState, useEffect } from "react"
import { useRouter } from "next/navigation"
import { Dialog, DialogContent } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { ChevronRight, X, Wallet } from "lucide-react"
import { TourOverlay } from "./tour-overlay"
import { useTourSpotlight } from "@/hooks/use-tour-spotlight"
import { supabase } from "@/lib/supabase"

interface TourStep {
  selector: string | null
  title: string
  message: string
  direction: "top" | "bottom" | "left" | "right"
}

const TOUR_STEPS: TourStep[] = [
  {
    selector: null,
    title: "Your Wallet Balance",
    message: "👈 This shows your available balance. You'll use this to buy data packages. Currently, it's empty.",
    direction: "bottom",
  },
  {
    selector: '[data-tour="wallet-topup"]',
    title: "Top Up Your Wallet",
    message: "👈 Click here to add funds to your wallet. You can use different payment methods like Paystack, MTN Mobile Money, etc.",
    direction: "bottom",
  },
]

interface WalletOnboardingModalProps {
  open: boolean
  onComplete: () => void
}

export function WalletOnboardingModal({ open, onComplete }: WalletOnboardingModalProps) {
  const router = useRouter()
  const [currentStep, setCurrentStep] = useState(0)
  const [showTour, setShowTour] = useState(false)
  const [walletBalance, setWalletBalance] = useState<number | null>(null)
  const { spotlight, highlightElement, clearSpotlight } = useTourSpotlight()

  useEffect(() => {
    // Fetch wallet balance when modal opens
    if (open) {
      const fetchBalance = async () => {
        try {
          const { data: { session } } = await supabase.auth.getSession()
          if (!session?.access_token) {
            console.error("No auth session")
            setWalletBalance(0)
            return
          }

          const response = await fetch("/api/wallet/balance", {
            headers: {
              "Authorization": `Bearer ${session.access_token}`,
            },
          })
          const data = await response.json()
          setWalletBalance(data.balance || 0)
        } catch (err) {
          console.error("Error fetching wallet balance:", err)
          setWalletBalance(0)
        }
      }
      fetchBalance()
    }
  }, [open])

  useEffect(() => {
    if (showTour && currentStep < TOUR_STEPS.length) {
      const timer = setTimeout(() => {
        const step = TOUR_STEPS[currentStep]
        if (step.selector) {
          highlightElement(step.selector)
        } else {
          clearSpotlight()
        }
      }, 500)
      return () => clearTimeout(timer)
    } else if (!showTour) {
      clearSpotlight()
    }
  }, [showTour, currentStep, highlightElement, clearSpotlight])

  const handleStartTour = () => {
    setShowTour(true)
    setCurrentStep(0)
  }

  const handleSpotlightClick = () => {
    // If on step 2 (wallet topup), navigate to wallet page
    if (currentStep === 1) {
      handleComplete()
      router.push("/dashboard/wallet")
    }
  }

  const handleNext = () => {
    if (currentStep < TOUR_STEPS.length - 1) {
      setCurrentStep(currentStep + 1)
    } else {
      handleComplete()
    }
  }

  const handlePrevious = () => {
    if (currentStep > 0) {
      setCurrentStep(currentStep - 1)
    } else {
      setShowTour(false)
      setCurrentStep(0)
    }
  }

  const handleComplete = () => {
    clearSpotlight()
    setShowTour(false)
    setCurrentStep(0)
    onComplete()
  }

  const progress = showTour
    ? ((currentStep + 1) / TOUR_STEPS.length) * 100
    : 0

  return (
    <>
      <TourOverlay
        spotlight={spotlight}
        message={showTour && TOUR_STEPS[currentStep] ? TOUR_STEPS[currentStep].message : ""}
        direction={showTour && TOUR_STEPS[currentStep] ? TOUR_STEPS[currentStep].direction : "bottom"}
        onElementClick={handleSpotlightClick}
      />

      <Dialog open={open} onOpenChange={(isOpen) => {
        if (!isOpen) {
          handleComplete()
        }
      }}>
        <DialogContent className="max-w-2xl w-[95vw] max-h-[90vh] overflow-y-auto sm:w-full">
          <div className="space-y-6">
            {/* Header */}
            <div className="flex items-center justify-between">
              <div className="flex-1">
                <h2 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
                  <Wallet className="w-6 h-6 text-green-600" />
                  {showTour ? TOUR_STEPS[currentStep]?.title : "Let's Set Up Your Wallet"}
                </h2>
                {showTour && (
                  <p className="text-sm text-gray-500 mt-1">
                    Step {currentStep + 1} of {TOUR_STEPS.length}
                  </p>
                )}
              </div>
              <button
                onClick={handleComplete}
                className="text-gray-400 hover:text-gray-600 transition"
                aria-label="Close onboarding"
              >
                <X className="w-6 h-6" />
              </button>
            </div>

            {/* Progress Bar */}
            {showTour && <Progress value={progress} className="h-2" />}

            {/* Content */}
            <div className="min-h-[300px] py-6">
              {!showTour ? (
                <div className="space-y-6 text-center">
                  <div className="text-6xl">💰</div>

                  <div className="space-y-3">
                    <h3 className="text-3xl font-bold text-gray-900">
                      Start Your Journey
                    </h3>
                    <p className="text-lg text-gray-600 max-w-md mx-auto">
                      Before you can buy data packages, you need to fund your wallet. Let's show you how!
                    </p>
                  </div>

                  <div className="bg-blue-50 border border-blue-200 rounded-lg p-6 text-left max-w-md mx-auto space-y-4">
                    <h4 className="font-semibold text-gray-900 text-center">What you'll learn:</h4>
                    <ul className="space-y-2 text-sm text-gray-700">
                      <li className="flex gap-3">
                        <span className="text-green-600 font-bold">1</span>
                        <span>View your wallet balance</span>
                      </li>
                      <li className="flex gap-3">
                        <span className="text-green-600 font-bold">2</span>
                        <span>Top up with different payment methods</span>
                      </li>
                      <li className="flex gap-3">
                        <span className="text-green-600 font-bold">3</span>
                        <span>Start buying data packages immediately</span>
                      </li>
                    </ul>
                  </div>

                  <div className="space-y-3">
                    <Button
                      onClick={handleStartTour}
                      size="lg"
                      className="w-full bg-gradient-to-r from-green-600 to-emerald-600 gap-2"
                    >
                      <span>Show Me How</span>
                      <ChevronRight className="w-4 h-4" />
                    </Button>
                    <Button
                      onClick={handleComplete}
                      variant="outline"
                      size="lg"
                      className="w-full"
                    >
                      Skip for Now
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="space-y-4 text-center py-8">
                  <div className="text-5xl">👆</div>
                  <h3 className="text-xl font-bold text-gray-900">
                    {TOUR_STEPS[currentStep]?.title}
                  </h3>
                  
                  {/* Show wallet balance on step 1 */}
                  {currentStep === 0 && (
                    <div className="bg-green-50 border border-green-200 rounded-lg p-6 my-6">
                      <p className="text-sm text-gray-600 mb-2">Your Current Balance</p>
                      <div className="text-4xl font-bold text-green-600">
                        GHS {walletBalance !== null ? walletBalance.toFixed(2) : '0.00'}
                      </div>
                    </div>
                  )}
                  
                  <p className="text-gray-600 max-w-lg mx-auto">
                    {TOUR_STEPS[currentStep]?.message}
                  </p>
                </div>
              )}
            </div>

            {/* Footer Navigation */}
            <div className="flex items-center justify-between pt-6 border-t border-gray-200">
              {showTour ? (
                <>
                  <Button
                    variant="outline"
                    onClick={handlePrevious}
                    className="gap-2"
                  >
                    Back
                  </Button>
                  <span className="text-sm text-gray-500">
                    {currentStep + 1} / {TOUR_STEPS.length}
                  </span>
                  <Button
                    onClick={handleNext}
                    className="gap-2 bg-gradient-to-r from-green-600 to-emerald-600"
                  >
                    {currentStep === TOUR_STEPS.length - 1 ? "Done" : "Next"}
                    <ChevronRight className="w-4 h-4" />
                  </Button>
                </>
              ) : (
                <>
                  <div />
                  <Button
                    onClick={handleComplete}
                    variant="ghost"
                  >
                    Close
                  </Button>
                </>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
