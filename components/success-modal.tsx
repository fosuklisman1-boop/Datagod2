"use client"

import { CheckCircle, X } from "lucide-react"
import { Button } from "@/components/ui/button"

interface SuccessModalProps {
  open: boolean
  onClose: () => void
  title: string
  message: string
  details?: Array<{ label: string; value: string }>
  actionLabel?: string
  onAction?: () => void
}

export function SuccessModal({
  open,
  onClose,
  title,
  message,
  details,
  actionLabel,
  onAction,
}: SuccessModalProps) {
  if (!open) return null

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50 animate-in fade-in duration-200">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden animate-in zoom-in-95 duration-300">
        {/* Close Button */}
        <div className="flex justify-end p-3 pb-0">
          <button
            onClick={onClose}
            className="p-1 rounded-full hover:bg-gray-100 transition-colors"
          >
            <X className="w-5 h-5 text-gray-400" />
          </button>
        </div>

        {/* Icon & Title */}
        <div className="text-center px-6 pb-4">
          <div className="flex justify-center mb-4">
            <div className="bg-gradient-to-br from-green-400 to-emerald-500 rounded-full p-4 shadow-lg shadow-green-200">
              <CheckCircle className="w-10 h-10 text-white" />
            </div>
          </div>
          <h2 className="text-xl font-bold text-gray-900 mb-2">{title}</h2>
          <p className="text-gray-600 text-sm">{message}</p>
        </div>

        {/* Details */}
        {details && details.length > 0 && (
          <div className="mx-6 mb-4 p-4 bg-gray-50 rounded-xl space-y-2">
            {details.map((detail, index) => (
              <div key={index} className="flex justify-between items-center">
                <span className="text-sm text-gray-500">{detail.label}</span>
                <span className="text-sm font-semibold text-gray-900">{detail.value}</span>
              </div>
            ))}
          </div>
        )}

        {/* Actions */}
        <div className="px-6 pb-6 space-y-2">
          {actionLabel && onAction && (
            <Button
              onClick={onAction}
              className="w-full bg-gradient-to-r from-green-500 to-emerald-600 hover:from-green-600 hover:to-emerald-700"
            >
              {actionLabel}
            </Button>
          )}
          <Button
            onClick={onClose}
            variant="outline"
            className="w-full"
          >
            Close
          </Button>
        </div>
      </div>
    </div>
  )
}
