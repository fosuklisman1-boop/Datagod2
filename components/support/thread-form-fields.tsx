"use client"

import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import type { useThreadForm } from "@/hooks/use-thread-form"

type Form = ReturnType<typeof useThreadForm>

/** Description, phone, WhatsApp and optional screenshot, shared by both dialogs. */
export function ThreadFormFields({ form }: { form: Form }) {
  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="support-message">What went wrong?</Label>
        <Textarea
          id="support-message"
          value={form.message}
          onChange={(e) => form.setMessage(e.target.value)}
          maxLength={1000}
          rows={4}
          placeholder="Describe the problem (5 to 1000 characters)"
        />
        <p className="text-right text-xs text-muted-foreground">{form.message.length}/1000</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="support-phone">Phone number</Label>
          <Input id="support-phone" inputMode="tel" value={form.phone} onChange={(e) => form.setPhone(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="support-whatsapp">WhatsApp number</Label>
          <Input id="support-whatsapp" inputMode="tel" value={form.whatsapp} onChange={(e) => form.setWhatsapp(e.target.value)} />
        </div>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="support-image">Add a screenshot (optional)</Label>
        <Input
          key={form.fileKey}
          id="support-image"
          type="file"
          accept="image/jpeg,image/png,image/webp"
          onChange={(e) => form.pickImage(e.target.files?.[0] ?? null)}
        />
        <p className="text-xs text-muted-foreground">JPG, PNG or WebP, up to 4 MB.</p>
      </div>
      {form.error && <p role="alert" className="text-sm text-destructive">{form.error}</p>}
    </div>
  )
}
