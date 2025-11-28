'use client'

import React from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Separator } from '@/components/ui/separator'
import { AlertTriangle, RefreshCw, Undo2, Home, ChevronRight } from 'lucide-react'

export interface RecoveryOption {
  id: string
  label: string
  description: string
  action: () => void
  isPrimary?: boolean
  isDestructive?: boolean
}

interface ErrorRecoveryProps {
  title?: string
  message: string
  error?: string
  recoveryOptions: RecoveryOption[]
  isDraft?: boolean
  draftInfo?: {
    savedAt: string
    package?: string
    network?: string
  }
}

export const ErrorRecovery: React.FC<ErrorRecoveryProps> = ({
  title = 'Something Went Wrong',
  message,
  error,
  recoveryOptions,
  isDraft,
  draftInfo,
}) => {
  return (
    <div className="space-y-6 max-w-2xl mx-auto">
      {/* Error Banner */}
      <Alert variant="destructive" className="border-2">
        <AlertTriangle className="h-5 w-5" />
        <AlertTitle className="text-base">{title}</AlertTitle>
        <AlertDescription className="mt-2 text-sm">{message}</AlertDescription>
        {error && (
          <AlertDescription className="mt-2 text-xs bg-red-100 p-2 rounded font-mono overflow-auto max-h-24">
            {error}
          </AlertDescription>
        )}
      </Alert>

      {/* Draft Info */}
      {isDraft && draftInfo && (
        <Card className="bg-amber-50 border-amber-200">
          <CardContent className="pt-4 pb-4">
            <div className="space-y-2">
              <div className="flex items-start gap-2">
                <div className="text-amber-600 mt-1">💾</div>
                <div className="flex-1">
                  <p className="font-semibold text-amber-900 text-sm">Incomplete Order Saved</p>
                  <p className="text-xs text-amber-800 mt-1">
                    We found your unsaved order from {draftInfo.savedAt}
                  </p>
                  {draftInfo.package && (
                    <p className="text-xs text-amber-800 mt-1">
                      Package: <span className="font-semibold">{draftInfo.package}</span>
                    </p>
                  )}
                  {draftInfo.network && (
                    <p className="text-xs text-amber-800">
                      Network: <span className="font-semibold">{draftInfo.network}</span>
                    </p>
                  )}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Recovery Options */}
      <div className="space-y-3">
        <h3 className="font-semibold text-gray-900">What would you like to do?</h3>
        <div className="grid grid-cols-1 gap-2">
          {recoveryOptions.map((option, index) => (
            <Button
              key={option.id}
              onClick={option.action}
              variant={option.isPrimary ? 'default' : option.isDestructive ? 'destructive' : 'outline'}
              className="h-auto py-3 px-4 justify-start text-left"
            >
              <div className="flex items-center justify-between w-full">
                <div className="flex-1">
                  <p className="font-semibold text-sm">{option.label}</p>
                  <p className="text-xs opacity-80 mt-1">{option.description}</p>
                </div>
                <ChevronRight className="h-5 w-5 opacity-50 ml-4 flex-shrink-0" />
              </div>
            </Button>
          ))}
        </div>
      </div>

      {/* Helpful Tips */}
      <Card className="bg-blue-50 border-blue-200">
        <CardContent className="pt-4 pb-4">
          <div className="space-y-2">
            <p className="font-semibold text-blue-900 text-sm">💡 Troubleshooting Tips</p>
            <ul className="space-y-1 text-xs text-blue-800">
              <li>• Check your internet connection and try again</li>
              <li>• Clear your browser cache if issues persist</li>
              <li>• Try using a different browser or device</li>
              <li>• Contact support if the problem continues</li>
            </ul>
          </div>
        </CardContent>
      </Card>

      {/* Support Info */}
      <Card className="border-gray-200">
        <CardContent className="pt-4 pb-4">
          <div className="space-y-2 text-sm">
            <p className="font-semibold text-gray-900">Need Additional Help?</p>
            <p className="text-gray-600 text-xs">
              If you continue to experience issues, our support team is ready to assist you.
            </p>
            <div className="flex gap-2 mt-3">
              <Button variant="outline" size="sm" className="text-xs">
                Contact Support
              </Button>
              <Button variant="outline" size="sm" className="text-xs">
                View FAQ
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
