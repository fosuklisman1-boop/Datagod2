"use client"

import { useState, useEffect } from "react"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Phone, Loader2 } from "lucide-react"
import { supabase } from "@/lib/supabase"
import { toast } from "sonner"

interface PhoneRequiredModalProps {
  open: boolean
  onPhoneSaved: (phone: string) => void
}

export function PhoneRequiredModal({ open, onPhoneSaved }: PhoneRequiredModalProps) {
  const [phone, setPhone] = useState("")
  const [isSaving, setIsSaving] = useState(false)

  const handleSavePhone = async () => {
    // Validate phone
    if (!phone || phone.trim() === '') {
      toast.error("Phone number is required")
      return
    }

    const phoneDigits = phone.replace(/\D/g, '')
    if (phoneDigits.length < 9 || phoneDigits.length > 10) {
      toast.error("Phone number must be 9 or 10 digits")
      return
    }

    setIsSaving(true)
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) {
        toast.error("Not authenticated")
        return
      }

      // Check if phone already exists
      const checkResponse = await fetch("/api/auth/check-phone", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phoneNumber: phone }),
      })

      if (!checkResponse.ok) {
        const error = await checkResponse.json()
        toast.error(error.error || "Phone number validation failed")
        setIsSaving(false)
        return
      }

      // Update phone number
      const { error } = await supabase
        .from("users")
        .update({ phone_number: phone })
        .eq("id", user.id)

      if (error) {
        toast.error(error.message || "Failed to save phone number")
        return
      }

      toast.success("Phone number saved successfully!")
      onPhoneSaved(phone)
    } catch (error) {
      console.error("Error saving phone:", error)
      toast.error("Failed to save phone number")
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={() => {
      // Prevent closing - user must add phone
      toast.error("Please add your phone number to continue")
    }}>
      <DialogContent className="max-w-md" onPointerDownOutside={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Phone className="w-5 h-5 text-blue-600" />
            Phone Number Required
          </DialogTitle>
          <DialogDescription>
            Please add your phone number to continue using the platform. This helps us verify your account and send important order updates.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <label className="text-sm font-medium text-gray-700">Phone Number *</label>
            <Input
              type="tel"
              placeholder="Enter your phone number"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              disabled={isSaving}
              className="mt-1"
            />
            <p className="text-xs text-gray-500 mt-1">Must be 9 or 10 digits</p>
          </div>
          <Button
            onClick={handleSavePhone}
            disabled={isSaving || !phone || phone.trim() === ''}
            className="w-full bg-blue-600 hover:bg-blue-700"
          >
            {isSaving && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
            {isSaving ? "Saving..." : "Save Phone Number"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
