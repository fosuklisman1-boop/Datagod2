"use client"

import { Suspense } from "react"
import LoginForm from "../login-form"
import StorefrontRedirector from "@/components/StorefrontRedirector"

export default function LoginPage() {
  return (
    <Suspense fallback={<div className="min-h-screen flex items-center justify-center">Loading...</div>}>
      <StorefrontRedirector />
      <LoginForm />
    </Suspense>
  )
}
