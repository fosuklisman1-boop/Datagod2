import { Suspense } from "react"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import SmsPlatformPage from "./_components/SmsPlatformPage"

export default function AdminSmsPage() {
  return (
    <DashboardLayout>
      <Suspense fallback={null}>
        <SmsPlatformPage />
      </Suspense>
    </DashboardLayout>
  )
}
