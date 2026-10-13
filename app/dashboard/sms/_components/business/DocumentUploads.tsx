"use client"

import { useRef, useState } from "react"
import { toast } from "sonner"
import { CheckCircle2, Circle, Loader2, Upload } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { smsFetch } from "../../_lib/api"
import { checkKycFile } from "../../_lib/view"
import type { BusinessProfile } from "./useBusiness"

type Kind = "ghana_card" | "registration"

interface Props {
  profile: BusinessProfile | null
  editable: boolean
  disabled?: boolean
  onUploaded: (p: BusinessProfile) => void
}

export function DocumentUploads({ profile, editable, disabled, onUploaded }: Props) {
  // Rejected: the next save/upload starts a new draft with no documents, so show them as not uploaded.
  const rejected = profile?.status === "rejected"
  const rows: { kind: Kind; label: string; hint: string; has: boolean }[] = [
    { kind: "ghana_card", label: "Ghana Card photo", hint: "Required. A clear photo of the front of your card.", has: !rejected && !!profile?.has_ghana_card_doc },
    { kind: "registration", label: "Business registration", hint: "Optional. Certificate or similar document.", has: !rejected && !!profile?.has_registration_doc },
  ]
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">Documents</legend>
      <p className="text-xs text-muted-foreground">JPG, PNG, WEBP or PDF, up to 4 MB each. Files are used only to verify your business.</p>
      <ul className="space-y-2">
        {rows.map((r) => <DocRow key={r.kind} {...r} editable={editable} disabled={disabled} onUploaded={onUploaded} />)}
      </ul>
    </fieldset>
  )
}

function DocRow({ kind, label, hint, has, editable, disabled, onUploaded }: {
  kind: Kind; label: string; hint: string; has: boolean; editable: boolean; disabled?: boolean; onUploaded: (p: BusinessProfile) => void
}) {
  const ref = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const id = `kyc-doc-${kind}`

  async function onPick(file: File | undefined) {
    if (!file) return
    const bad = checkKycFile(file)
    if (bad) { toast.error(bad); if (ref.current) ref.current.value = ""; return }
    setBusy(true)
    const body = new FormData()
    body.append("kind", kind)
    body.append("file", file)
    const r = await smsFetch<BusinessProfile>("/api/sms/business/documents", { method: "POST", body })
    setBusy(false)
    if (ref.current) ref.current.value = ""
    if (r.ok) { toast.success(`${label} uploaded.`); onUploaded(r.data) } else toast.error(r.error)
  }

  return (
    <li className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3">
      <div className="flex min-w-0 items-start gap-2">
        {has ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden /> : <Circle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />}
        <div className="min-w-0">
          <Label htmlFor={id} className="text-sm">{label}</Label>
          <p className="text-xs text-muted-foreground">{has ? "Uploaded" : "Not uploaded"} · {hint}</p>
        </div>
      </div>
      {editable && (
        <>
          <input id={id} ref={ref} type="file" accept="image/jpeg,image/png,image/webp,application/pdf" className="sr-only" disabled={busy || disabled} onChange={(e) => void onPick(e.target.files?.[0])} />
          <Button type="button" size="sm" variant="outline" disabled={busy || disabled} onClick={() => ref.current?.click()} aria-label={`${has ? "Replace" : "Upload"} ${label}`}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />} {has ? "Replace" : "Upload"}
          </Button>
        </>
      )}
    </li>
  )
}
