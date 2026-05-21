"use client"

import { DashboardAIChatWidget } from "@/components/dashboard/AIChatWidget"

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      {children}
      <DashboardAIChatWidget />
    </>
  )
}
