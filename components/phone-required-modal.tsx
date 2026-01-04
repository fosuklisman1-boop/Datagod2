"use client"

import { useState } from "react"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Phone, Loader2, MessageCircle, AlertTriangle } from "lucide-react"
import { supabase } from "@/lib/supabase"
import { toast } from "sonner"

interface PhoneRequiredModalProps {
  open: boolean
  onPhoneSaved: (phone: string) => void
}

const SUPPORT_WHATSAPP = "233559717923" // Support WhatsApp number

export function PhoneRequiredModal({ open, onPhoneSaved }: PhoneRequiredModalProps) {
  const [phone, setPhone] = useState("")
  const [isSaving, setIsSaving] = useState(false)
  const [phoneExistsError, setPhoneExistsError] = useState(false)

  const handleSavePhone = async () => {
    // Reset error state
    setPhoneExistsError(false)
    
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
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) {
        toast.error("Not authenticated")
        setIsSaving(false)
        return
      }

      // Use the API endpoint to update phone (uses service role, bypasses RLS)
      const response = await fetch("/api/user/update-phone", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ phoneNumber: phone }),
      })

      const data = await response.json()

      if (!response.ok) {
        // Check if it's a "phone already exists" error
        if (data.error?.toLowerCase().includes("already registered") || data.error?.toLowerCase().includes("already exists")) {
          setPhoneExistsError(true)
        } else {
          toast.error(data.error || "Failed to save phone number")
        }
        setIsSaving(false)
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

  const handleContactSupport = () => {
    const message = encodeURIComponent(`Hello, I'm having an issue with my phone number. It says "${phone}" is already registered but I believe this is my number. Can you please help?`)
    window.open(`https://wa.me/${SUPPORT_WHATSAPP}?text=${message}`, "_blank")
  }

  return (
    <Dialog open={open} onOpenChange={() => {
      // Prevent closing - user must add phone
      toast.error("Please add your phone number to continue")
    }}>
      <DialogContent className="max-w-md" onPointerDownOutside={(e) => e.preventDefault()} onEscapeKeyDown={(e) => e.preventDefault()}>
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
          {phoneExistsError && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
              <div className="flex items-start gap-3">
                <AlertTriangle className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
                <div className="space-y-2">
                  <p className="text-sm text-amber-800 font-medium">
                    This phone number is already registered
                  </p>
                  <p className="text-xs text-amber-700">
                    If you believe this is your number and it's been registered by mistake, please contact our support team for assistance.
                  </p>
                  <Button
                    onClick={handleContactSupport}
                    variant="outline"
                    size="sm"
                    className="mt-2 border-amber-300 text-amber-800 hover:bg-amber-100"
                  >
                    <MessageCircle className="w-4 h-4 mr-2" />
                    Contact Support on WhatsApp
                  </Button>
                </div>
              </div>
            </div>
          )}
          <div>
            <label className="text-sm font-medium text-gray-700">Phone Number *</label>
            <Input
              type="tel"
              placeholder="Enter your phone number"
              value={phone}
              onChange={(e) => {
                setPhone(e.target.value)
                setPhoneExistsError(false) // Reset error when typing
              }}
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
