"use client"

import { AdminAIChatWidget } from "@/components/admin/AdminAIChatWidget"

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      {children}
      <AdminAIChatWidget />
    </>
  )
}
