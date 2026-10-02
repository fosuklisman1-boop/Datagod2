"use client"

import { AlertCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useAuth } from "@/hooks/use-auth"

export default function DashboardUnavailablePage() {
  const { logout } = useAuth()

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background px-6 text-center">
      <AlertCircle className="h-10 w-10 text-muted-foreground" />
      <h1 className="text-xl font-bold text-foreground">No features are currently available</h1>
      <p className="max-w-sm text-sm text-muted-foreground">
        This domain isn't currently configured to show any pages for your account. Please contact the site owner, or sign out and try a different account.
      </p>
      <Button onClick={() => logout()} variant="outline">Sign Out</Button>
    </div>
  )
}
