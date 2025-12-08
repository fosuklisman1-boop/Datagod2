"use client"

import { useState, useEffect } from "react"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Loader2, AlertCircle, CheckCircle } from "lucide-react"
import { supabase } from "@/lib/supabase"
import { toast } from "sonner"

interface AFASubmissionModalProps {
  isOpen: boolean
  onClose: () => void
  userId: string
  packagePrice: number
  onSubmitSuccess?: () => void
}

export function AFASubmissionModal({
  isOpen,
  onClose,
  userId,
  packagePrice,
  onSubmitSuccess,
}: AFASubmissionModalProps) {
  const [fullName, setFullName] = useState("")
  const [phoneNumber, setPhoneNumber] = useState("")
  const [walletBalance, setWalletBalance] = useState(0)
  const [loading, setLoading] = useState(false)
  const [fetchingBalance, setFetchingBalance] = useState(false)
  const [submitted, setSubmitted] = useState(false)

  // Fetch wallet balance when modal opens
  useEffect(() => {
    if (isOpen && userId) {
      fetchWalletBalance()
    }
  }, [isOpen, userId])

  const fetchWalletBalance = async () => {
    try {
      setFetchingBalance(true)
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) throw new Error("No session")

      const response = await fetch("/api/wallet/balance", {
        headers: {
          Authorization: `Bearer ${session.access_token}`,
        },
      })
      if (!response.ok) throw new Error("Failed to fetch balance")

      const data = await response.json()
      setWalletBalance(data.balance || 0)
    } catch (error) {
      console.error("Error fetching wallet balance:", error)
      toast.error("Failed to fetch wallet balance")
    } finally {
      setFetchingBalance(false)
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()

    // Validation
    if (!fullName.trim()) {
      toast.error("Please enter full name")
      return
    }

    if (!phoneNumber.trim()) {
      toast.error("Please enter phone number")
      return
    }

    // Check balance
    if (walletBalance < packagePrice) {
      toast.error(`Insufficient balance. Required: GHS ${packagePrice.toFixed(2)}, Available: GHS ${walletBalance.toFixed(2)}`)
      return
    }

    try {
      setLoading(true)
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) throw new Error("No session")

      // Submit AFA order
      const response = await fetch("/api/afa/submit", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          fullName: fullName.trim(),
          phoneNumber: phoneNumber.trim(),
          amount: packagePrice,
          userId,
        }),
      })

      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.message || "Failed to submit AFA order")
      }

      const data = await response.json()
      toast.success("AFA registration submitted successfully!")
      setSubmitted(true)

      // Reset form after 2 seconds
      setTimeout(() => {
        setFullName("")
        setPhoneNumber("")
        setSubmitted(false)
        onClose()
        onSubmitSuccess?.()
      }, 2000)
    } catch (error) {
      console.error("Error submitting AFA order:", error)
      toast.error(error instanceof Error ? error.message : "Failed to submit AFA order")
    } finally {
      setLoading(false)
    }
  }

  const handleClose = () => {
    if (!loading && !submitted) {
      setFullName("")
      setPhoneNumber("")
      setSubmitted(false)
      onClose()
    }
  }

  const hasSufficientBalance = walletBalance >= packagePrice
  const isPhoneValid = /^[0-9\s\-\+\(\)]{10,}$/.test(phoneNumber.replace(/\s/g, ""))

  return (
    <Dialog open={isOpen} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>MTN AFA Registration</DialogTitle>
          <DialogDescription>
            Submit your registration details for MTN AFA package
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6">
          {/* Package Info */}
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
            <h3 className="font-semibold text-blue-900 mb-2">Exclusive Member Package</h3>
            <p className="text-sm text-blue-700">
              Amount: <span className="font-bold">GHS {packagePrice.toFixed(2)}</span>
            </p>
          </div>

          {/* Balance Status */}
          <div>
            {fetchingBalance ? (
              <div className="flex items-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin" />
                <span className="text-sm">Checking wallet balance...</span>
              </div>
            ) : (
              <div className={`p-3 rounded-lg border ${
                hasSufficientBalance
                  ? "bg-green-50 border-green-200"
                  : "bg-red-50 border-red-200"
              }`}>
                <div className="flex items-center gap-2">
                  {hasSufficientBalance ? (
                    <CheckCircle className="w-5 h-5 text-green-600" />
                  ) : (
                    <AlertCircle className="w-5 h-5 text-red-600" />
                  )}
                  <div>
                    <p className={`text-sm font-medium ${
                      hasSufficientBalance ? "text-green-900" : "text-red-900"
                    }`}>
                      Wallet Balance: GHS {walletBalance.toFixed(2)}
                    </p>
                    {!hasSufficientBalance && (
                      <p className="text-xs text-red-700">
                        Insufficient balance. Top up your wallet to proceed.
                      </p>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Form */}
          {!submitted && (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Full Name <span className="text-red-500">*</span>
                </label>
                <Input
                  placeholder="e.g. John Doe"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  disabled={loading}
                  className="w-full"
                />
                <p className="text-xs text-gray-600 mt-1">
                  Full name must be provided for verification
                </p>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Phone Number <span className="text-red-500">*</span>
                </label>
                <Input
                  placeholder="e.g. 0241234567"
                  value={phoneNumber}
                  onChange={(e) => setPhoneNumber(e.target.value)}
                  disabled={loading}
                  className="w-full"
                />
                <p className="text-xs text-gray-600 mt-1">
                  Must be a valid Ghanaian phone number
                </p>
              </div>

              {/* Requirements */}
              <Alert>
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>
                  <p className="font-medium text-sm mb-2">Requirements & Terms:</p>
                  <ul className="text-xs space-y-1">
                    <li>✓ Must be a valid Ghanaian phone number</li>
                    <li>✓ Full name must be provided for verification</li>
                    <li>✓ Payment will be deducted from wallet</li>
                    <li>✓ Non-refundable application fee</li>
                  </ul>
                </AlertDescription>
              </Alert>

              {/* Buttons */}
              <div className="flex gap-3">
                <Button
                  type="button"
                  variant="outline"
                  onClick={handleClose}
                  disabled={loading}
                  className="flex-1"
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  disabled={loading || !hasSufficientBalance || !fullName.trim() || !phoneNumber.trim()}
                  className="flex-1"
                >
                  {loading ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      Submitting...
                    </>
                  ) : (
                    "Submit Application"
                  )}
                </Button>
              </div>
            </form>
          )}

          {/* Success Message */}
          {submitted && (
            <div className="py-8 text-center">
              <CheckCircle className="w-12 h-12 text-green-600 mx-auto mb-3" />
              <h3 className="font-semibold text-lg text-gray-900 mb-2">Application Submitted!</h3>
              <p className="text-sm text-gray-600">
                Your AFA registration has been submitted successfully.
                We will process it shortly.
              </p>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
