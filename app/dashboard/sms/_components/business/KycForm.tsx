"use client"

import { useState } from "react"
import { toast } from "sonner"
import { AlertCircle, BadgeCheck, Hourglass, Loader2, Save, Send } from "lucide-react"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { smsFetch, type SmsMode } from "../../_lib/api"
import { cardEnding, kycEditable, kycFieldErrors, kycFormFromProfile, kycPayload, kycSubmitGaps, type KycForm as KycFormValues } from "../../_lib/view"
import { DocumentUploads } from "./DocumentUploads"
import type { BusinessProfile } from "./useBusiness"

interface Props {
  profile: BusinessProfile | null
  mode: SmsMode
  onProfile: (p: BusinessProfile) => void
  /** Re-fetch everything (e.g. after submit, since approval can flip the mode). */
  onChanged: () => void
}

export function KycForm({ profile, mode, onProfile, onChanged }: Props) {
  const status = profile?.status ?? null
  const editable = kycEditable(status)
  const [form, setForm] = useState<KycFormValues>(() => kycFormFromProfile(profile))
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<"save" | "submit" | null>(null)

  const set = (k: keyof KycFormValues) => (v: string) => {
    setForm((f) => ({ ...f, [k]: v }))
    if (errors[k]) setErrors((e) => { const n = { ...e }; delete n[k]; return n })
  }

  if (status === "approved") {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base"><BadgeCheck className="h-4 w-4 text-success" aria-hidden /> Business verified</CardTitle>
          <CardDescription>
            {mode === "business" ? <>Your account is in <Badge variant="outline" className="border-primary/30 bg-primary/10 text-primary">Business</Badge> mode.</> : "Your business is approved. Your account is being switched to Business mode."}
          </CardDescription>
        </CardHeader>
        <CardContent><Summary profile={profile} /></CardContent>
      </Card>
    )
  }

  if (status === "submitted") {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base"><Hourglass className="h-4 w-4 text-warning" aria-hidden /> Application under review</CardTitle>
          <CardDescription>We&apos;ll review your business details shortly. You can&apos;t edit while it&apos;s in review.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Summary profile={profile} />
          <DocumentUploads profile={profile} editable={false} onUploaded={onProfile} />
        </CardContent>
      </Card>
    )
  }

  const gaps = kycSubmitGaps(form, profile)

  /** Returns true when the draft is saved. Client errors and server `fields` errors are shown per field. */
  async function save(): Promise<boolean> {
    const local = kycFieldErrors(form)
    if (Object.keys(local).length > 0) { setErrors(local); toast.error("Fix the highlighted fields first."); return false }
    const r = await smsFetch<BusinessProfile>("/api/sms/business", { method: "PUT", body: JSON.stringify(kycPayload(form)) })
    if (!r.ok) {
      const fields = r.body.fields
      if (fields && typeof fields === "object") setErrors(fields as Record<string, string>)
      toast.error(r.error)
      return false
    }
    setErrors({})
    onProfile(r.data)
    setForm((f) => ({ ...f, ghana_card_number: "" })) // stored (last 4 only); no longer needs re-entry
    return true
  }

  async function onSave() {
    setBusy("save")
    if (await save()) toast.success("Draft saved.")
    setBusy(null)
  }

  async function onSubmit() {
    setBusy("submit")
    if (await save()) {
      const r = await smsFetch<BusinessProfile>("/api/sms/business/submit", { method: "POST" })
      if (r.ok) { toast.success("Application submitted for review."); onProfile(r.data); onChanged() } else toast.error(r.error)
    }
    setBusy(null)
  }

  const ending = cardEnding(profile?.ghana_card_last4)

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{status === "rejected" ? "Update and resubmit" : "Verify your business"}</CardTitle>
        <CardDescription>Verified businesses get Business mode: more sender IDs and higher limits.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {status === "rejected" && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              <p className="font-medium">Your application was not approved.</p>
              {profile?.rejection_reason && <p className="mt-0.5">{profile.rejection_reason}</p>}
              <p className="mt-1 text-xs">Edit your details below and resubmit. Please upload your documents again.</p>
            </AlertDescription>
          </Alert>
        )}

        <Field id="kyc-name" label="Business name" error={errors.business_name} hint="2–120 characters.">
          <Input id="kyc-name" value={form.business_name} onChange={(e) => set("business_name")(e.target.value)} maxLength={120} autoComplete="organization" aria-invalid={!!errors.business_name} aria-describedby={errors.business_name ? "kyc-name-err" : undefined} />
        </Field>

        <Field id="kyc-desc" label="What does your business do?" error={errors.description} hint={`10–2000 characters. ${form.description.trim().length}/2000`}>
          <Textarea id="kyc-desc" value={form.description} onChange={(e) => set("description")(e.target.value)} rows={4} maxLength={2000} aria-invalid={!!errors.description} aria-describedby={errors.description ? "kyc-desc-err" : undefined} />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="kyc-web" label="Website (optional)" error={errors.website} hint="e.g. kingsdata.com">
            <Input id="kyc-web" value={form.website} onChange={(e) => set("website")(e.target.value)} inputMode="url" autoComplete="url" aria-invalid={!!errors.website} aria-describedby={errors.website ? "kyc-web-err" : undefined} />
          </Field>
          <Field id="kyc-wa" label="WhatsApp number" error={errors.whatsapp_number} hint="e.g. 024 123 4567">
            <Input id="kyc-wa" value={form.whatsapp_number} onChange={(e) => set("whatsapp_number")(e.target.value)} inputMode="tel" autoComplete="tel" aria-invalid={!!errors.whatsapp_number} aria-describedby={errors.whatsapp_number ? "kyc-wa-err" : undefined} />
          </Field>
        </div>

        <Field
          id="kyc-card" label="Ghana Card number" error={errors.ghana_card_number}
          hint={ending ? `${ending} saved. Only enter a number if you want to change it. We keep just the last 4 digits.` : "Format GHA-123456789-0. We keep just the last 4 digits."}
        >
          <Input id="kyc-card" value={form.ghana_card_number} onChange={(e) => set("ghana_card_number")(e.target.value.toUpperCase())} placeholder={ending ?? "GHA-123456789-0"} maxLength={15} autoComplete="off" aria-invalid={!!errors.ghana_card_number} aria-describedby={errors.ghana_card_number ? "kyc-card-err" : undefined} />
        </Field>

        <DocumentUploads profile={profile} editable disabled={busy !== null} onUploaded={onProfile} />

        {gaps.length > 0 && <p className="text-xs text-muted-foreground">Still needed to submit: {gaps.join(", ")}.</p>}

        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" onClick={() => void onSave()} disabled={busy !== null}>
            {busy === "save" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Save draft
          </Button>
          <Button type="button" onClick={() => void onSubmit()} disabled={busy !== null || gaps.length > 0}>
            {busy === "submit" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} {status === "rejected" ? "Resubmit for review" : "Submit for review"}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

function Field({ id, label, error, hint, children }: { id: string; label: string; error?: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {error ? <p id={`${id}-err`} role="alert" className="text-xs text-destructive">{error}</p> : hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  )
}

function Summary({ profile }: { profile: BusinessProfile | null }) {
  if (!profile) return null
  const rows: [string, string | null][] = [
    ["Business", profile.business_name], ["Website", profile.website], ["WhatsApp", profile.whatsapp_number], ["Ghana Card", cardEnding(profile.ghana_card_last4)],
  ]
  return (
    <dl className="grid gap-2 text-sm sm:grid-cols-2">
      {rows.filter(([, v]) => v).map(([k, v]) => (
        <div key={k}><dt className="text-xs text-muted-foreground">{k}</dt><dd className="break-words font-medium">{v}</dd></div>
      ))}
    </dl>
  )
}
