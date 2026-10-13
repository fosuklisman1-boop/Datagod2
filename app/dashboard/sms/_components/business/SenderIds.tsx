"use client"

import { useState } from "react"
import { toast } from "sonner"
import { BadgeCheck, Info, Loader2, Send, Smartphone } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { smsFetch, type SmsMode } from "../../_lib/api"
import { checkSenderInput, formatSenderInput, senderRequestBlock, senderStatus, senderSuggestions, toneBadgeClass } from "../../_lib/view"
import Link from "next/link"
import type { SenderRow } from "./useBusiness"

interface Props {
  mode: SmsMode | null
  rows: SenderRow[]
  shopName: string
  kycStatus: string | null
  onChanged: () => void
}

export function SenderIds({ mode, rows, shopName, kycStatus, onChanged }: Props) {
  const [value, setValue] = useState("")
  const [busy, setBusy] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const own = rows.filter((r) => !r.is_pool)
  const active = own.find((r) => r.local_status === "active")
  const block = senderRequestBlock(mode, own)
  const suggestions = shopName ? senderSuggestions(shopName) : []
  const previewName = value.trim() || active?.sender_id || shopName || "Your Shop"

  async function request() {
    const check = checkSenderInput(value)
    if (!check.ok) { setFormError(check.reason); return }
    setBusy(true)
    const r = await smsFetch("/api/sms/sender-ids", { method: "POST", body: JSON.stringify({ sender_id: check.name }) })
    setBusy(false)
    if (r.ok) {
      toast.success(`Requested “${check.name}”. The Datagod team will review it. Check back shortly.`)
      setValue(""); setFormError(null); onChanged()
    } else setFormError(r.error)
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="flex items-center gap-2 text-base"><BadgeCheck className="h-4 w-4 text-primary" aria-hidden /> Your Sender ID</CardTitle>
        <Badge variant="outline" className={toneBadgeClass(active ? "success" : own.some((r) => r.local_status === "pending") ? "warning" : "muted")}>
          {active ? "Active" : own.some((r) => r.local_status === "pending") ? "Under review" : "Not set"}
        </Badge>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2 rounded-lg border bg-muted/30 p-3">
          <p className="flex items-center gap-1.5 text-sm font-medium"><Info className="h-3.5 w-3.5" aria-hidden /> What is a sender ID?</p>
          <p className="text-xs text-muted-foreground">
            It&apos;s the name your customers see instead of a phone number: up to <span className="font-medium text-foreground">11 characters</span> (letters, numbers and spaces). Every request is reviewed to prevent impersonation.
          </p>
          <div className="rounded-md border bg-background p-3">
            <p className="mb-1.5 flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground"><Smartphone className="h-3 w-3" aria-hidden /> On your customer&apos;s phone</p>
            <div className="flex items-start gap-2">
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-primary/10 text-xs font-bold text-primary">{previewName.slice(0, 2).toUpperCase()}</span>
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold">{previewName}</p>
                <p className="text-xs text-muted-foreground">Your order of GHS 25 MTN data is confirmed. Thank you!</p>
              </div>
            </div>
          </div>
        </div>

        {block ? (
          <div className="rounded-lg border border-primary/20 bg-primary/5 p-3 text-sm">
            <p>{block}</p>
            {mode !== "business" && kycStatus !== "approved" && (
              <p className="mt-1 text-xs text-muted-foreground">
                {kycStatus === "submitted" ? "Your business verification is in review." : <>Complete <a href="#verify" className="font-medium text-primary hover:underline">business verification</a> above to unlock more.</>}
              </p>
            )}
          </div>
        ) : (
          <div className="space-y-2">
            {mode !== "business" && (
              <p className="text-xs text-muted-foreground">Platform mode includes <span className="font-medium text-foreground">one free sender ID</span>. Verify your business to request up to 200.</p>
            )}
            {suggestions.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5 text-xs">
                <span className="text-muted-foreground">Suggestions:</span>
                {suggestions.map((s) => (
                  <button key={s} type="button" onClick={() => { setValue(formatSenderInput(s)); setFormError(null) }} className="rounded-full bg-muted px-2.5 py-1 font-mono font-medium hover:bg-accent">{s}</button>
                ))}
              </div>
            )}
            <Label htmlFor="sender-request">Request a sender ID</Label>
            <div className="flex gap-2">
              <Input
                id="sender-request" value={value} maxLength={11} placeholder="e.g. KFT SHOP" className="uppercase"
                onChange={(e) => { setValue(formatSenderInput(e.target.value)); setFormError(null) }}
                onKeyDown={(e) => { if (e.key === "Enter" && value.trim() && !busy) void request() }}
                aria-invalid={!!formError} aria-describedby={formError ? "sender-request-err" : "sender-request-hint"}
              />
              <Button type="button" onClick={() => void request()} disabled={busy || !value.trim()} className="shrink-0">
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Request
              </Button>
            </div>
            {formError
              ? <p id="sender-request-err" role="alert" className="text-xs text-destructive">{formError}</p>
              : <p id="sender-request-hint" className="text-[11px] text-muted-foreground">{value.length}/11 characters · letters, numbers and spaces only.</p>}
          </div>
        )}

        {own.length > 0 && (
          <div className="border-t pt-3">
            <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Your sender IDs</p>
            <ul className="space-y-2">
              {own.map((s) => {
                const st = senderStatus(s.local_status)
                return (
                  <li key={s.id} className="text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono font-semibold">{s.sender_id}</span>
                      <Badge variant="outline" className={toneBadgeClass(st.tone)}>{st.label}</Badge>
                    </div>
                    {s.rejection_reason && (s.local_status === "rejected" || s.local_status === "revoked") && (
                      <p className="mt-0.5 text-xs text-muted-foreground">Reason: {s.rejection_reason}</p>
                    )}
                    {s.local_status === "paused" && (
                      <p className="mt-0.5 text-xs text-muted-foreground">Paused while your account is in Platform mode. Verify your business to use it again.</p>
                    )}
                  </li>
                )
              })}
            </ul>
          </div>
        )}
        {active && <p className="text-xs text-muted-foreground">Pick it as the sender when you <Link href="/dashboard/sms/compose" className="font-medium text-primary hover:underline">compose a message</Link>.</p>}
      </CardContent>
    </Card>
  )
}
