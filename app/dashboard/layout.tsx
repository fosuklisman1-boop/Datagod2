"use client"

import dynamic from "next/dynamic"

const DashboardAIChatWidget = dynamic(
  () => import("@/components/dashboard/AIChatWidget").then(m => ({ default: m.DashboardAIChatWidget })),
  { ssr: false }
)

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      {children}
      <DashboardAIChatWidget />
    </>
  )
}
