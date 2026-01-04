"use client"

import { useState } from "react"
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
        toast.error(data.error || "Failed to save phone number")
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

  return (
    <Dialog open={open} onOpenChange={(isOpen) => {
      if (!isOpen) {
        onPhoneSaved("") // Allow closing without saving
      }
    }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Phone className="w-5 h-5 text-blue-600" />
            Add Phone Number
          </DialogTitle>
          <DialogDescription>
            Please add your phone number to help us verify your account and send important order updates.
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
