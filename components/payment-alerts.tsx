import { AlertCircle, Lightbulb } from "lucide-react"
import { Alert, AlertDescription } from "@/components/ui/alert"

interface PopupBlockerAlertProps {
  show?: boolean
}

export function PopupBlockerAlert({ show = true }: PopupBlockerAlertProps) {
  if (!show) return null

  return (
    <Alert className="border-orange-200 bg-orange-50 mb-4">
      <AlertCircle className="h-4 w-4 text-orange-600" />
      <AlertDescription className="text-orange-800">
        <div className="font-semibold mb-1">Popup Blocker Detected</div>
        <p className="text-sm mb-2">
          Your browser may be blocking payment popups. If payment fails to load:
        </p>
        <ul className="text-sm list-disc list-inside space-y-1">
          <li>Check your browser's popup blocker settings</li>
          <li>Allow popups for this site</li>
          <li>If redirected to payment, please wait for the page to load</li>
          <li>Try using a different browser or disabling extensions that block popups</li>
        </ul>
      </AlertDescription>
    </Alert>
  )
}

interface PaymentHelpProps {
  title?: string
}

export function PaymentHelpMessage({ title = "Need help with payment?" }: PaymentHelpProps) {
  return (
    <Alert className="border-blue-200 bg-blue-50">
      <Lightbulb className="h-4 w-4 text-blue-600" />
      <AlertDescription className="text-blue-800">
        <div className="font-semibold mb-1">{title}</div>
        <p className="text-sm mb-2">
          If you experience issues with payment:
        </p>
        <ul className="text-sm list-disc list-inside space-y-1">
          <li>Ensure you have a stable internet connection</li>
          <li>Check that popups are enabled in your browser</li>
          <li>Try a different browser if the payment gateway doesn't load</li>
          <li>Clear your browser cache and try again</li>
          <li>Contact support if the issue persists</li>
        </ul>
      </AlertDescription>
    </Alert>
  )
}
