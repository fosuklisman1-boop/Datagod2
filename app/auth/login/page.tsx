"use client"

import { Suspense } from "react"
import LoginForm from "../login-form"
import { HomeAIChatWidget } from "@/components/home/AIChatWidgetLazy"

export default function LoginPage() {
  return (
    <>
      <Suspense fallback={<div className="min-h-screen flex items-center justify-center">Loading...</div>}>
        <LoginForm />
      </Suspense>
      <HomeAIChatWidget />
    </>
  )
}
