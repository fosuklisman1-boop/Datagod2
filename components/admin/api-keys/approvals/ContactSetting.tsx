"use client"

import { useEffect, useState } from "react"
import { ExternalLink, Loader2, MessageCircle } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { buildApprovalLink, parseApprovalContact } from "@/lib/api-v2/approval-contact"
import { adminFetch } from "../admin-fetch"
import { Eyebrow, Panel } from "../ui"

/**
 * The "Approval contact" setting: the WhatsApp number behind every Message admin button. Stored as digits; empty
 * means the general support number is used. The preview opens the exact link developers get.
 */
export function ContactSetting() {
  const [saved, setSaved] = useState<string | null>(null)
  const [value, setValue] = useState("")
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    void (async () => {
      const r = await adminFetch<{ approval_whatsapp?: string | null }>("/api/admin/api-v2/config")
      const v = r.ok ? r.data?.approval_whatsapp ?? null : null
      setSaved(v)
      setValue(v ?? "")
      setLoading(false)
    })()
  }, [])

  const parsed = parseApprovalContact(value)
  const preview = parsed.ok && parsed.digits ? buildApprovalLink(parsed.digits, { code: "API-TEST22", email: null }) : null

  const save = async () => {
    if (!parsed.ok) return
    setSaving(true)
    const r = await adminFetch<{ approval_whatsapp?: string | null; auditFailed?: boolean }>("/api/admin/api-v2/config", {
      method: "PUT",
      body: JSON.stringify({ approval_whatsapp: value.trim() }),
    })
    setSaving(false)
    if (!r.ok) {
      toast.error(r.error ?? "Could not save the contact")
      return
    }
    const v = r.data?.approval_whatsapp ?? null
    setSaved(v)
    setValue(v ?? "")
    toast.success(v ? "Approval contact saved" : "Cleared: the support number is used")
    if (r.data?.auditFailed) toast.warning("Saved, but the audit trail entry failed")
  }

  return (
    <Panel className="space-y-3">
      <Eyebrow>Approval contact</Eyebrow>
      <p className="text-sm text-muted-foreground">
        Developers waiting for approval see a <strong className="text-foreground">Message admin on WhatsApp</strong> button that opens this number with their request code typed in. Leave it empty to use the support number.
      </p>
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          value={value}
          disabled={loading}
          onChange={(e) => setValue(e.target.value)}
          placeholder="0559919037 or https://wa.me/233559919037"
          aria-label="Approval WhatsApp number or link"
          className="h-10 min-w-0 flex-1 rounded-xl border border-border bg-background px-3 text-sm"
        />
        <Button className="h-10 rounded-xl" disabled={loading || saving || !parsed.ok || value.trim() === (saved ?? "")} onClick={() => void save()}>
          {saving ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <MessageCircle className="size-4" aria-hidden />} Save
        </Button>
      </div>
      {!parsed.ok && <p className="text-xs text-destructive">{parsed.error}</p>}
      {preview && (
        <a href={preview} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-xs font-semibold text-primary hover:underline">
          <ExternalLink className="size-3.5" aria-hidden /> Preview the developer&apos;s WhatsApp message (code API-TEST22)
        </a>
      )}
    </Panel>
  )
}
