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
  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <div className="flex items-start justify-between">
            <DialogTitle className="text-2xl font-bold bg-gradient-to-r from-cyan-600 to-blue-600 bg-clip-text text-transparent">
              {title}
            </DialogTitle>
            <Button
              variant="ghost"
              size="sm"
              onClick={onClose}
              className="h-8 w-8 p-0"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </DialogHeader>
        <div className="mt-4">
          <DialogDescription className="text-base text-gray-700 whitespace-pre-wrap">
            {message}
          </DialogDescription>
        </div>
        <div className="flex justify-end mt-6">
          <Button
            onClick={onClose}
            className="bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-700 hover:to-blue-700"
          >
            Got it, thanks!
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
