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
  onSubmitSuccess?: () => void
}

export function AFASubmissionModal({
  isOpen,
  onClose,
  userId,
  onSubmitSuccess,
}: AFASubmissionModalProps) {
  const [fullName, setFullName] = useState("")
  const [phoneNumber, setPhoneNumber] = useState("")
  const [ghCardNumber, setGhCardNumber] = useState("")
  const [location, setLocation] = useState("")
  const [region, setRegion] = useState("")
  const [occupation, setOccupation] = useState("Farmer")
  const [walletBalance, setWalletBalance] = useState(0)
  const [loading, setLoading] = useState(false)
  const [fetchingBalance, setFetchingBalance] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [afaPrice, setAfaPrice] = useState(50)

  // Fetch wallet balance and AFA price when modal opens
  useEffect(() => {
    if (isOpen && userId) {
      fetchAfaPrice()
      fetchWalletBalance()
    }
  }, [isOpen, userId])

  const fetchAfaPrice = async () => {
    try {
      const response = await fetch("/api/afa/price")
      if (!response.ok) throw new Error("Failed to fetch price")

      const data = await response.json()
      setAfaPrice(data.price || 50)
    } catch (error) {
      console.error("Error fetching AFA price:", error)
      // Use default price
      setAfaPrice(50)
    }
  }

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

    if (!ghCardNumber.trim()) {
      toast.error("Please enter GH card number")
      return
    }

    if (!location.trim()) {
      toast.error("Please enter location")
      return
    }

    if (!region.trim()) {
      toast.error("Please select region")
      return
    }

    // Check balance
    if (walletBalance < afaPrice) {
      toast.error(`Insufficient balance. Required: GHS ${afaPrice.toFixed(2)}, Available: GHS ${walletBalance.toFixed(2)}`)
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
          ghCardNumber: ghCardNumber.trim(),
          location: location.trim(),
          region: region.trim(),
          occupation: occupation,
          amount: afaPrice,
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
        setGhCardNumber("")
        setLocation("")
        setRegion("")
        setOccupation("Farmer")
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
      setGhCardNumber("")
      setLocation("")
      setRegion("")
      setOccupation("Farmer")
      setSubmitted(false)
      onClose()
    }
  }

  const hasSufficientBalance = walletBalance >= afaPrice
  const isPhoneValid = /^[0-9\s\-\+\(\)]{10,}$/.test(phoneNumber.replace(/\s/g, ""))
  const isFormValid = fullName.trim() && phoneNumber.trim() && ghCardNumber.trim() && location.trim() && region.trim()

  return (
    <Dialog open={isOpen} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-[500px] max-h-[90vh] flex flex-col p-0">
        <DialogHeader className="px-4 sm:px-6 pt-4 sm:pt-6 flex-shrink-0">
          <DialogTitle>MTN AFA Registration</DialogTitle>
          <DialogDescription>
            Submit your registration details for MTN AFA package
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6 overflow-y-auto flex-1 px-4 sm:px-6">
          {/* Package Info */}
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
            <h3 className="font-semibold text-blue-900 mb-2">Exclusive Member Package</h3>
            <p className="text-sm text-blue-700">
              Amount: <span className="font-bold">GHS {afaPrice.toFixed(2)}</span>
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
            <form id="afa-form" onSubmit={handleSubmit} className="space-y-4">
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

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  GH Card Number <span className="text-red-500">*</span>
                </label>
                <Input
                  placeholder="e.g. GHA-123456789-0"
                  value={ghCardNumber}
                  onChange={(e) => setGhCardNumber(e.target.value)}
                  disabled={loading}
                  className="w-full"
                />
                <p className="text-xs text-gray-600 mt-1">
                  Your Ghana Card identification number
                </p>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Location <span className="text-red-500">*</span>
                  </label>
                  <Input
                    placeholder="e.g. Accra"
                    value={location}
                    onChange={(e) => setLocation(e.target.value)}
                    disabled={loading}
                    className="w-full"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Region <span className="text-red-500">*</span>
                  </label>
                  <select
                    value={region}
                    onChange={(e) => setRegion(e.target.value)}
                    disabled={loading}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="">Select Region</option>
                    <option value="Greater Accra">Greater Accra</option>
                    <option value="Ashanti">Ashanti</option>
                    <option value="Central">Central</option>
                    <option value="Eastern">Eastern</option>
                    <option value="Northern">Northern</option>
                    <option value="Oti">Oti</option>
                    <option value="Savanna">Savanna</option>
                    <option value="Upper East">Upper East</option>
                    <option value="Upper West">Upper West</option>
                    <option value="Volta">Volta</option>
                    <option value="Western">Western</option>
                    <option value="Western North">Western North</option>
                    <option value="North East">North East</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Occupation
                </label>
                <Input
                  value={occupation}
                  disabled={true}
                  className="w-full bg-gray-100 cursor-not-allowed"
                />
                <p className="text-xs text-gray-600 mt-1">
                  Occupation is prefilled and cannot be changed
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

        {/* Fixed Buttons at Bottom */}
        {!submitted && (
          <div className="border-t border-gray-200 px-4 sm:px-6 py-3 sm:py-4 flex gap-3 flex-shrink-0 bg-white">
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
              form="afa-form"
              disabled={loading || !hasSufficientBalance || !isFormValid}
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
        )}
      </DialogContent>
    </Dialog>
  )
}
