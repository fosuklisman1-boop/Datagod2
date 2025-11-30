"use client"

import { useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { AlertCircle, Loader2 } from "lucide-react"

interface PhoneNumberModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (phoneNumber: string) => void
  isLoading?: boolean
  packageName?: string
}

export function PhoneNumberModal({
  open,
  onOpenChange,
  onSubmit,
  isLoading = false,
  packageName = "Data Package",
}: PhoneNumberModalProps) {
  const [phoneNumber, setPhoneNumber] = useState("")
  const [error, setError] = useState<string | null>(null)

  const validatePhoneNumber = (phone: string): string | null => {
    if (!phone.trim()) {
      return "Phone number is required"
    }

    const cleaned = phone.replace(/\D/g, "")

    if (cleaned.length !== 10) {
      return "Phone number must be exactly 10 digits"
    }

    if (!cleaned.startsWith("0")) {
      return "Phone number must start with 0"
    }

    if (!["2", "5"].includes(cleaned[1])) {
      return "Phone number must start with 02 or 05"
    }

    return null
  }

  const handleSubmit = () => {
    const validationError = validatePhoneNumber(phoneNumber)
    if (validationError) {
      setError(validationError)
      return
    }

    setError(null)
    // Use the phone number as-is (already validated to be 10 digits)
    const cleaned = phoneNumber.replace(/\D/g, "")
    onSubmit(cleaned)
    setPhoneNumber("")
  }

  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen) {
      setPhoneNumber("")
      setError(null)
    }
    onOpenChange(newOpen)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>Confirm Phone Number</DialogTitle>
          <DialogDescription>
            Enter the phone number for your {packageName} order
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {error && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <div className="space-y-2">
            <Label htmlFor="phone">Phone Number</Label>
            <Input
              id="phone"
              placeholder="e.g., 0201234567 or 201234567"
              value={phoneNumber}
              onChange={(e) => {
                setPhoneNumber(e.target.value)
                setError(null)
              }}
              disabled={isLoading}
              type="tel"
            />
            <p className="text-xs text-gray-600">
              Format: 10 digits starting with 02 or 05
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => handleOpenChange(false)}
            disabled={isLoading}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={handleSubmit}
            disabled={isLoading || !phoneNumber.trim()}
          >
            {isLoading ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Processing...
              </>
            ) : (
              "Confirm Purchase"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
