"use client"

import { useState } from "react"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { toast } from "sonner"
import { Shield, ArrowLeft } from "lucide-react"
import { authService } from "@/lib/auth"

export default function ForgotPasswordPage() {
  const [step, setStep] = useState<"email" | "reset">("email")
  const [email, setEmail] = useState("")
  const [newPassword, setNewPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")
  const [isLoading, setIsLoading] = useState(false)

  const handleEmailSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setIsLoading(true)

    try {
      if (!email) {
        toast.error("Please enter your email")
        setIsLoading(false)
        return
      }

      await authService.resetPassword(email)
      toast.success("Password reset link sent to your email")
      setStep("reset")
    } catch (error: any) {
      const errorMessage = error?.message || "Failed to send reset email"
      toast.error(errorMessage)
      console.error("Reset password error:", error)
    } finally {
      setIsLoading(false)
    }
  }

  const handleResetSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setIsLoading(true)

    try {
      if (!newPassword || !confirmPassword) {
        toast.error("Please fill in all fields")
        setIsLoading(false)
        return
      }

      if (newPassword !== confirmPassword) {
        toast.error("Passwords do not match")
        setIsLoading(false)
        return
      }

      if (newPassword.length < 6) {
        toast.error("Password must be at least 6 characters")
        setIsLoading(false)
        return
      }

      await authService.updatePassword(newPassword)
      toast.success("Password reset successfully!")
      setTimeout(() => {
        window.location.href = "/auth/login"
      }, 2000)
    } catch (error: any) {
      const errorMessage = error?.message || "Failed to reset password"
      toast.error(errorMessage)
      console.error("Update password error:", error)
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-blue-50 to-indigo-100 p-4">
      <Card className="w-full max-w-md shadow-lg">
        <CardHeader className="space-y-2 text-center">
          <div className="flex justify-center mb-4">
            <div className="bg-gradient-to-br from-blue-600 to-purple-600 p-3 rounded-lg">
              <Shield className="w-8 h-8 text-white" />
            </div>
          </div>
          <CardTitle className="text-2xl font-bold">Reset Password</CardTitle>
          <CardDescription>
            {step === "email" && "Enter your email to receive a reset link"}
            {step === "reset" && "Create a new password"}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {/* Email Step */}
          {step === "email" && (
            <form onSubmit={handleEmailSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="email">Email Address</Label>
                <Input
                  id="email"
                  type="email"
                  placeholder="Enter your email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </div>
              <Button
                type="submit"
                className="w-full bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-700 hover:to-purple-700"
                disabled={isLoading}
              >
                {isLoading ? "Sending..." : "Send Reset Link"}
              </Button>
            </form>
          )}

          {/* Reset Password Step */}
          {step === "reset" && (
            <form onSubmit={handleResetSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="newPassword">New Password</Label>
                <Input
                  id="newPassword"
                  type="password"
                  placeholder="Enter new password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="confirmPassword">Confirm Password</Label>
                <Input
                  id="confirmPassword"
                  type="password"
                  placeholder="Confirm new password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  required
                />
              </div>
              <Button
                type="submit"
                className="w-full bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-700 hover:to-purple-700"
                disabled={isLoading}
              >
                {isLoading ? "Resetting..." : "Reset Password"}
              </Button>
              <Button
                type="button"
                variant="outline"
                className="w-full"
                onClick={() => setStep("email")}
              >
                <ArrowLeft className="w-4 h-4 mr-2" />
                Back
              </Button>
            </form>
          )}

          {/* Back to Login Link */}
          <div className="text-center mt-4">
            <Link href="/auth/login" className="text-sm text-gray-600 hover:underline">
              Back to Login
            </Link>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
