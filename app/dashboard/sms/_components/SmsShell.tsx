"use client"

import type { ReactNode } from "react"
import Link from "next/link"
import { AlertCircle, ArrowLeft, Ban, Info, Loader2, RefreshCw } from "lucide-react"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { useSmsAccount } from "../_lib/useSmsAccount"

export interface SmsShellProps {
  children: ReactNode
  /** Sub-pages pass true to show a "Back to SMS" link (Home at /dashboard/sms omits it). */
  backToHome?: boolean
  /** Page heading shown under the SMS title row; optional. */
  subtitle?: string
}

/**
 * Page chrome for every SMS page: DashboardLayout + standard container, header
 * (title, mode badge, Refresh), optional back link, suspended alert, and the
 * "temporarily unavailable" banner. While loading it shows a skeleton; on
 * load error or `notEntitled` it shows a card instead of `children`.
 * Must be rendered inside <SmsAccountProvider> (provided by layout.tsx).
 */
export function SmsShell({ children, backToHome = false, subtitle }: SmsShellProps) {
  const { account, mode, featureEnabled, loading, error, notEntitled, reload } = useSmsAccount()

  if (loading) {
    return (
      <DashboardLayout>
        <div className="max-w-4xl space-y-4 p-4 md:p-6 lg:max-w-5xl">
          <Skeleton className="h-9 w-40" /><Skeleton className="h-32 w-full" /><Skeleton className="h-64 w-full" />
        </div>
      </DashboardLayout>
    )
  }

  if (!account) {
    return (
      <DashboardLayout>
        <div className="max-w-md p-4 md:p-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <AlertCircle className="h-5 w-5 text-destructive" /> {error ? "Couldn’t load SMS" : "Bulk SMS not available yet"}
              </CardTitle>
              <CardDescription>
                {error
                  ? "We couldn’t load your SMS account. Check your connection and try again."
                  : "Bulk SMS is available to shop owners, sub-agents, and admins. Create a shop to unlock it."}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {notEntitled && !error ? (
                <Button asChild><Link href="/dashboard/my-shop">Create a Shop</Link></Button>
              ) : (
                <Button onClick={() => { void reload() }}><Loader2 className="h-4 w-4" /> Retry</Button>
              )}
            </CardContent>
          </Card>
        </div>
      </DashboardLayout>
    )
  }

  const isSuspended = account.status === "suspended"

  return (
    <DashboardLayout>
      <div className="max-w-4xl space-y-6 p-4 md:p-6 lg:max-w-5xl">
        {backToHome && (
          <Link href="/dashboard/sms" className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground">
            <ArrowLeft className="h-4 w-4" /> Back to SMS
          </Link>
        )}

        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-bold text-foreground">SMS</h1>
              {mode && (
                <Badge variant="outline" className="border-primary/30 bg-primary/10 text-primary">
                  {mode === "business" ? "Business" : "Platform"}
                </Badge>
              )}
            </div>
            {subtitle && <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>}
          </div>
          <Button variant="outline" size="sm" onClick={() => { void reload() }} className="shrink-0">
            <RefreshCw className="h-4 w-4" /> Refresh
          </Button>
        </div>

        {isSuspended && (
          <Alert variant="destructive">
            <Ban className="h-4 w-4" />
            <AlertDescription>Your SMS account is suspended. Contact support to restore sending.</AlertDescription>
          </Alert>
        )}

        {error && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
              <span>Couldn’t refresh your SMS account. Showing the last loaded data.</span>
              <Button size="sm" variant="outline" onClick={() => { void reload() }}>Retry</Button>
            </AlertDescription>
          </Alert>
        )}

        {!featureEnabled && (
          <Alert className="border-warning/30 bg-warning/10">
            <Info className="h-4 w-4" />
            <AlertDescription>SMS is temporarily unavailable. Sending and purchases are paused — please try again later.</AlertDescription>
          </Alert>
        )}

        {children}
      </div>
    </DashboardLayout>
  )
}
