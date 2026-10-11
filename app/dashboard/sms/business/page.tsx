"use client"

import { AlertCircle } from "lucide-react"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { useSmsAccount } from "../_lib/useSmsAccount"
import { kycSteps } from "../_lib/view"
import { SmsShell } from "../_components/SmsShell"
import { KycForm } from "../_components/business/KycForm"
import { ModeComparison } from "../_components/business/ModeComparison"
import { SenderIds } from "../_components/business/SenderIds"
import { Stepper } from "../_components/business/Stepper"
import { useBusiness } from "../_components/business/useBusiness"

function BusinessContent() {
  const { mode: accountMode } = useSmsAccount()
  const { data, senders, shopName, loading, error, reload, setProfile } = useBusiness()

  if (loading) return <div className="space-y-4"><Skeleton className="h-20 w-full" /><Skeleton className="h-72 w-full" /></div>

  if (!data) {
    return (
      <Alert variant="destructive">
        <AlertCircle className="h-4 w-4" />
        <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
          <span>{error ?? "Couldn’t load your business application."}</span>
          <Button size="sm" variant="outline" onClick={() => { void reload() }}>Retry</Button>
        </AlertDescription>
      </Alert>
    )
  }

  const mode = data.mode ?? accountMode
  const profile = data.profile
  const hasActiveSender = senders.some((s) => s.local_status === "active" && !s.is_pool)

  return (
    <div className="space-y-6">
      <Card><CardContent className="p-4"><Stepper steps={kycSteps(profile?.status ?? null, hasActiveSender)} /></CardContent></Card>
      {error && (
        <Alert variant="destructive"><AlertCircle className="h-4 w-4" /><AlertDescription>Couldn’t refresh your application. Showing the last loaded data.</AlertDescription></Alert>
      )}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="space-y-6">
          <div id="verify" className="scroll-mt-20">
            <KycForm profile={profile} mode={mode} onProfile={setProfile} onChanged={() => { void reload() }} />
          </div>
          <SenderIds mode={mode} rows={senders} shopName={shopName} kycStatus={profile?.status ?? null} onChanged={() => { void reload() }} />
        </div>
        <div className="lg:sticky lg:top-4 lg:self-start"><ModeComparison mode={mode} /></div>
      </div>
    </div>
  )
}

export default function SmsBusinessPage() {
  return (
    <SmsShell backToHome subtitle="Business & Sender ID">
      <BusinessContent />
    </SmsShell>
  )
}
