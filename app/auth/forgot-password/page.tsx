"use client"

import { useState } from "react"
import Link from "next/link"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ArrowLeft, Loader2, CheckCircle2 } from "lucide-react"

export default function ForgotPasswordPage() {
  const [contact, setContact] = useState("")
  const [loading, setLoading] = useState(false)
  const [success, setSuccess] = useState(false)
  const [error, setError] = useState("")

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError("")
    setSuccess(false)

    try {
      const res = await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contact }),
      })

      const data = await res.json()

      if (!res.ok) {
        throw new Error(data.error || "Failed to request password reset")
      }

      setSuccess(true)
    } catch (err: any) {
      setError(err.message || "Something went wrong")
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 via-indigo-50 to-purple-50 flex items-center justify-center p-4">
      <Card className="w-full max-w-md shadow-lg">
        <CardHeader className="text-center pb-2">
          <div className="flex justify-center mb-4">
            <div className="bg-white p-3 rounded-full">
              <img src="/favicon-v2.jpeg" alt="DATAGOD Logo" className="w-6 h-6 rounded-lg object-cover" />
            </div>
          </div>
          <CardTitle>Reset Password</CardTitle>
          <CardDescription>
            Enter your registered email or phone number
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 pt-4">
          {success ? (
            <div className="text-center space-y-4 px-2">
              <div className="flex justify-center">
                <CheckCircle2 className="h-12 w-12 text-emerald-500" />
              </div>
              <h3 className="text-lg font-medium text-gray-900">Registration Checked</h3>
              <p className="text-sm text-gray-500">
                If an account matches <span className="font-semibold">{contact}</span>, a password reset link has been sent. The link will expire in 5 minutes.
              </p>
              <Button 
                variant="outline" 
                className="w-full mt-4"
                onClick={() => {
                  setSuccess(false)
                  setContact("")
                }}
              >
                Try a different account
              </Button>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2">
                <Input
                  id="contact"
                  placeholder="name@example.com or 055XXXXXXX"
                  value={contact}
                  onChange={(e) => setContact(e.target.value)}
                  className="w-full"
                  required
                />
              </div>

              {error && (
                <div className="p-3 text-sm text-red-500 bg-red-50 rounded-md">
                  {error}
                </div>
              )}

              <Button
                type="submit"
                className="w-full bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 text-white"
                disabled={loading || !contact}
              >
                {loading ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Sending Reset Link...
                  </>
                ) : (
                  "Send Reset Link"
                )}
              </Button>
            </form>
          )}

          <div className="text-center mt-6">
            <Link href="/auth/login" className="text-sm text-indigo-600 hover:underline flex items-center justify-center gap-1">
              <ArrowLeft className="w-3 h-3" /> Back to Login
            </Link>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
