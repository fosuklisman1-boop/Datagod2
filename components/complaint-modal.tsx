"use client"

import { useState, useEffect } from "react"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Card, CardContent } from "@/components/ui/card"
import { Upload, AlertCircle, Loader2, CheckCircle } from "lucide-react"
import { toast } from "sonner"
import { useAuth } from "@/hooks/use-auth"

interface ComplaintModalProps {
  isOpen: boolean
  onClose: () => void
  orderId: string
  orderDetails: {
    networkName: string
    packageName: string
    phoneNumber: string
    totalPrice: number
    createdAt: string
  }
}

interface UploadedFile {
  name: string
  file: File
  preview: string
}

export function ComplaintModal({ isOpen, onClose, orderId, orderDetails }: ComplaintModalProps) {
  const { user } = useAuth()
  const [description, setDescription] = useState("")
  const [balanceImage, setBalanceImage] = useState<UploadedFile | null>(null)
  const [momoReceiptImage, setMomoReceiptImage] = useState<UploadedFile | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [selectedPriority, setSelectedPriority] = useState("medium")

  const handleImageUpload = (
    e: React.ChangeEvent<HTMLInputElement>,
    setImage: (file: UploadedFile | null) => void
  ) => {
    const file = e.target.files?.[0]
    if (file) {
      // Validate file size (max 5MB)
      if (file.size > 5 * 1024 * 1024) {
        toast.error("File size must be less than 5MB")
        return
      }

      // Validate file type
      if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
        toast.error("Only JPG, PNG, and WebP images are allowed")
        return
      }

      const preview = URL.createObjectURL(file)
      setImage({ name: file.name, file, preview })
    }
  }

  const handleSubmit = async () => {
    // Validation
    if (!user) {
      toast.error("User not authenticated")
      return
    }

    if (!description.trim()) {
      toast.error("Please describe your complaint")
      return
    }

    if (!balanceImage) {
      toast.error("Please upload data balance evidence")
      return
    }

    if (!momoReceiptImage) {
      toast.error("Please upload MoMo receipt evidence")
      return
    }

    if (description.trim().length < 10) {
      toast.error("Complaint description must be at least 10 characters")
      return
    }

    try {
      setIsSubmitting(true)

      // Upload images and create complaint
      const formData = new FormData()
      formData.append("orderId", orderId)
      formData.append("userId", user.id)
      formData.append("description", description)
      formData.append("priority", selectedPriority)
      formData.append("balanceImage", balanceImage.file)
      formData.append("momoReceiptImage", momoReceiptImage.file)

      // Add order details as JSON
      formData.append("orderDetails", JSON.stringify(orderDetails))

      const response = await fetch("/api/complaints/create", {
        method: "POST",
        body: formData,
      })

      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.message || "Failed to submit complaint")
      }

      const result = await response.json()
      toast.success("Complaint submitted successfully!")
      
      // Reset form
      setDescription("")
      setBalanceImage(null)
      setMomoReceiptImage(null)
      setSelectedPriority("medium")
      onClose()
    } catch (error) {
      console.error("Error submitting complaint:", error)
      toast.error(error instanceof Error ? error.message : "Failed to submit complaint")
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>File a Complaint</DialogTitle>
          <DialogDescription>
            Report an issue with your data order. Please provide evidence of the problem.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6">
          {/* Order Summary */}
          <Card className="bg-gradient-to-br from-blue-50 to-cyan-50 border-blue-200">
            <CardContent className="pt-4">
              <div className="space-y-2 text-sm">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <p className="text-xs font-semibold text-gray-600">Network</p>
                    <p className="font-medium">{orderDetails.networkName}</p>
                  </div>
                  <div>
                    <p className="text-xs font-semibold text-gray-600">Package</p>
                    <p className="font-medium">{orderDetails.packageName}</p>
                  </div>
                  <div>
                    <p className="text-xs font-semibold text-gray-600">Phone Number</p>
                    <p className="font-mono">{orderDetails.phoneNumber}</p>
                  </div>
                  <div>
                    <p className="text-xs font-semibold text-gray-600">Amount Paid</p>
                    <p className="font-medium">GHS {orderDetails.totalPrice.toFixed(2)}</p>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Priority Selection */}
          <div>
            <Label htmlFor="priority" className="text-sm font-semibold mb-2 block">
              Issue Priority *
            </Label>
            <select
              id="priority"
              title="Select issue priority"
              value={selectedPriority}
              onChange={(e) => setSelectedPriority(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              disabled={isSubmitting}
            >
              <option value="low">Low - Minor inconvenience</option>
              <option value="medium">Medium - Moderate issue</option>
              <option value="high">High - Serious issue, cannot use data</option>
            </select>
          </div>

          {/* Description */}
          <div>
            <Label htmlFor="description" className="text-sm font-semibold mb-2 block">
              Describe the Issue *
            </Label>
            <textarea
              id="description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Explain what happened. For example: 'Purchased 2GB but received only 1GB', 'Data expired immediately after purchase', etc."
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
              rows={4}
              disabled={isSubmitting}
            />
            <p className="text-xs text-gray-500 mt-1">
              Minimum 10 characters required
            </p>
          </div>

          {/* Image Uploads */}
          <div className="space-y-4">
            <Alert className="border-blue-300 bg-blue-50">
              <AlertCircle className="h-4 w-4 text-blue-600" />
              <AlertDescription className="text-blue-700">
                Upload screenshots or photos as evidence:
              </AlertDescription>
            </Alert>

            {/* Data Balance Evidence */}
            <div className="border-2 border-dashed border-gray-300 rounded-lg p-4">
              <Label className="text-sm font-semibold mb-3 block">
                Data Balance Evidence *
              </Label>
              <p className="text-xs text-gray-600 mb-3">
                Screenshot showing your data balance (with amount you have remaining)
              </p>

              {balanceImage ? (
                <div className="space-y-2">
                  <div className="relative w-full h-40 bg-gray-100 rounded-lg overflow-hidden border border-green-200">
                    <img
                      src={balanceImage.preview}
                      alt="Data Balance"
                      className="w-full h-full object-contain"
                    />
                    <div className="absolute top-2 right-2 bg-green-500 text-white rounded-full p-1">
                      <CheckCircle className="w-4 h-4" />
                    </div>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => setBalanceImage(null)}
                    disabled={isSubmitting}
                  >
                    Change Image
                  </Button>
                </div>
              ) : (
                <label className="flex items-center justify-center w-full cursor-pointer hover:bg-gray-50 transition">
                  <div className="flex flex-col items-center justify-center py-6">
                    <Upload className="w-8 h-8 text-gray-400 mb-2" />
                    <p className="text-sm text-gray-600">Click to upload image</p>
                    <p className="text-xs text-gray-500">JPG, PNG, WebP (Max 5MB)</p>
                  </div>
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    onChange={(e) => handleImageUpload(e, setBalanceImage)}
                    className="hidden"
                    disabled={isSubmitting}
                  />
                </label>
              )}
            </div>

            {/* MoMo Receipt Evidence */}
            <div className="border-2 border-dashed border-gray-300 rounded-lg p-4">
              <Label className="text-sm font-semibold mb-3 block">
                MoMo Receipt / Payment Evidence *
              </Label>
              <p className="text-xs text-gray-600 mb-3">
                Screenshot of your Mobile Money receipt showing the transaction
              </p>

              {momoReceiptImage ? (
                <div className="space-y-2">
                  <div className="relative w-full h-40 bg-gray-100 rounded-lg overflow-hidden border border-green-200">
                    <img
                      src={momoReceiptImage.preview}
                      alt="MoMo Receipt"
                      className="w-full h-full object-contain"
                    />
                    <div className="absolute top-2 right-2 bg-green-500 text-white rounded-full p-1">
                      <CheckCircle className="w-4 h-4" />
                    </div>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => setMomoReceiptImage(null)}
                    disabled={isSubmitting}
                  >
                    Change Image
                  </Button>
                </div>
              ) : (
                <label className="flex items-center justify-center w-full cursor-pointer hover:bg-gray-50 transition">
                  <div className="flex flex-col items-center justify-center py-6">
                    <Upload className="w-8 h-8 text-gray-400 mb-2" />
                    <p className="text-sm text-gray-600">Click to upload image</p>
                    <p className="text-xs text-gray-500">JPG, PNG, WebP (Max 5MB)</p>
                  </div>
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    onChange={(e) => handleImageUpload(e, setMomoReceiptImage)}
                    className="hidden"
                    disabled={isSubmitting}
                  />
                </label>
              )}
            </div>
          </div>

          {/* Action Buttons */}
          <div className="flex gap-2 justify-end border-t pt-4">
            <Button
              onClick={onClose}
              variant="outline"
              disabled={isSubmitting}
            >
              Cancel
            </Button>
            <Button
              onClick={handleSubmit}
              disabled={isSubmitting}
              className="bg-gradient-to-r from-blue-600 to-cyan-600 hover:from-blue-700 hover:to-cyan-700"
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Submitting...
                </>
              ) : (
                <>
                  <AlertCircle className="w-4 h-4 mr-2" />
                  Submit Complaint
                </>
              )}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
