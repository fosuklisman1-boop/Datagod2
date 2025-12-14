"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { ArrowLeft, Mail, MessageCircle } from "lucide-react"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { supportSettingsService } from "@/lib/support-settings-service"

export default function ForgotPasswordPage() {
  const [supportSettings, setSupportSettings] = useState<any>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    loadSupportSettings()
  }, [])

  const loadSupportSettings = async () => {
    try {
      const settings = await supportSettingsService.getSupportSettings()
      setSupportSettings(settings)
    } catch (error) {
      console.error("Error loading support settings:", error)
    } finally {
      setLoading(false)
    }
  }

  const handleWhatsAppContact = () => {
    if (!supportSettings?.support_whatsapp) return
    const message = "Hi, I need help resetting my password."
    const url = supportSettingsService.formatWhatsAppURL(
      supportSettings.support_whatsapp,
      message
    )
    window.open(url, "_blank")
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 via-indigo-50 to-purple-50 flex items-center justify-center p-4">
      <Card className="w-full max-w-md shadow-lg">
        <CardHeader className="text-center pb-2">
          <div className="flex justify-center mb-4">
            <div className="bg-white p-3 rounded-full">
              <img src="/favicon-v2.jpeg" alt="DATAGOD Logo" className="w-6 h-6 rounded-lg" />
            </div>
          </div>
          <CardTitle>Password Reset</CardTitle>
          <CardDescription>
            Contact our support team to reset your password
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {!loading && supportSettings && (
            <>
              <Alert className="border-green-300 bg-green-50">
                <MessageCircle className="h-4 w-4 text-green-600" />
                <AlertDescription className="text-sm text-green-700 mt-2">
                  <p className="font-semibold mb-3">Contact us via WhatsApp:</p>
                  <Button
                    onClick={handleWhatsAppContact}
                    className="w-full bg-gradient-to-r from-green-600 to-emerald-600 hover:from-green-700 hover:to-emerald-700 text-white"
                  >
                    <MessageCircle className="w-4 h-4 mr-2" />
                    Chat on WhatsApp
                  </Button>
                  <p className="text-xs mt-3">
                    Our support team will verify your identity and reset your password.
                  </p>
                </AlertDescription>
              </Alert>

              <div className="bg-gray-50 p-4 rounded-lg border border-gray-200">
                <h3 className="font-semibold text-gray-900 mb-2">What to tell our support team:</h3>
                <ul className="text-sm text-gray-700 space-y-1 list-disc list-inside">
                  <li>Your registered email address</li>
                  <li>Your full name</li>
                  <li>Subject: "Password Reset Request"</li>
                </ul>
              </div>

              {supportSettings.support_email && (
                <Alert className="border-blue-300 bg-blue-50">
                  <Mail className="h-4 w-4 text-blue-600" />
                  <AlertDescription className="text-xs text-blue-700 mt-2">
                    <p className="font-semibold mb-1">Prefer email?</p>
                    <p>Email: <a href={`mailto:${supportSettings.support_email}`} className="underline font-semibold hover:no-underline">{supportSettings.support_email}</a></p>
                  </AlertDescription>
                </Alert>
              )}
            </>
          )}

          <div className="text-center">
            <Link href="/auth/login" className="text-sm text-indigo-600 hover:underline flex items-center justify-center gap-1">
              <ArrowLeft className="w-3 h-3" /> Back to Login
            </Link>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
