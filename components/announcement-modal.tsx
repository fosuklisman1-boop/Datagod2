"use client"

import { useState, useEffect } from "react"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { X } from "lucide-react"

interface AnnouncementModalProps {
  isOpen: boolean
  onClose: () => void
  title: string
  message: string
}

export function AnnouncementModal({ isOpen, onClose, title, message }: AnnouncementModalProps) {
  const [timeLeft, setTimeLeft] = useState(15)

  useEffect(() => {
    if (!isOpen) {
      if (timeLeft !== 15) setTimeLeft(15)
      return
    }

    if (timeLeft <= 0) {
      onClose()
      return
    }

    const timer = setInterval(() => {
      setTimeLeft((prev) => prev - 1)
    }, 1000)

    return () => clearInterval(timer)
  }, [isOpen, timeLeft, onClose])

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl bg-white/95 backdrop-blur-xl border border-blue-200/50 shadow-2xl">
        <DialogHeader>
          <div className="flex items-start justify-between">
            <DialogTitle className="text-2xl font-bold bg-gradient-to-r from-cyan-600 to-blue-600 bg-clip-text text-transparent">
              {title}
            </DialogTitle>
            <Button
              variant="ghost"
              size="sm"
              onClick={onClose}
              className="h-8 w-8 p-0 hover:bg-red-50 hover:text-red-500 rounded-full transition-colors"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </DialogHeader>
        <div className="mt-4">
          <DialogDescription className="text-base text-gray-700 whitespace-pre-wrap leading-relaxed">
            {message}
          </DialogDescription>
        </div>
        <div className="flex justify-end mt-8">
          <Button
            onClick={onClose}
            className="relative overflow-hidden group bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-700 hover:to-blue-700 px-8 py-6 text-lg font-bold shadow-lg shadow-blue-200"
          >
            <span className="relative z-10 flex items-center gap-2">
              Got it, thanks! <span className="opacity-70 font-normal">({timeLeft}s)</span>
            </span>
            {/* Countdown Progress Background */}
            <div 
              className="absolute inset-0 bg-white/20 origin-left transition-transform duration-1000 ease-linear"
              style={{ transform: `scaleX(${timeLeft / 15})` }}
            />
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
