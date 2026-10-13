import { useState } from "react"
import { Copy, Eye, EyeOff, Loader2, Smartphone } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { INSERT_CHIPS } from "../../_lib/view"

interface Props {
  message: string
  onChange: (m: string) => void
  resolved: string
  busy: boolean
  onSaveTemplate: (name: string) => Promise<boolean>
  onOpenTemplates: () => void
  templateCount: number
}

export function MessageEditor({ message, onChange, resolved, busy, onSaveTemplate, onOpenTemplates, templateCount }: Props) {
  const [showPreview, setShowPreview] = useState(false)
  const [saving, setSaving] = useState(false)
  const [name, setName] = useState("")

  function insertChip(text: string) {
    onChange((message.length && !/\s$/.test(message) ? message + " " : message) + text)
  }

  async function save() {
    if (await onSaveTemplate(name)) { setSaving(false); setName("") }
  }

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <Label htmlFor="msg" className="text-muted-foreground">Message</Label>
          <div className="flex items-center gap-3">
            <button type="button" onClick={onOpenTemplates} className="flex items-center gap-1 text-sm text-primary hover:underline">
              <Copy className="h-4 w-4" /> Templates{templateCount > 0 ? ` (${templateCount})` : ""}
            </button>
            <button type="button" onClick={() => setShowPreview((s) => !s)} className="flex items-center gap-1 text-sm text-primary hover:underline">
              {showPreview ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />} {showPreview ? "Hide Preview" : "Show Preview"}
            </button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-muted-foreground">Insert:</span>
          {INSERT_CHIPS.map((c) => (
            <button key={c.label} type="button" onClick={() => insertChip(c.insert)}
              className="rounded-full bg-muted px-2.5 py-1 text-xs font-medium hover:bg-accent">
              {c.label}
            </button>
          ))}
        </div>

        <Textarea id="msg" rows={4} value={message} onChange={(e) => onChange(e.target.value)}
          placeholder="Type your message…" maxLength={1000} />
      </div>

      {showPreview && (
        <div className="rounded-lg border bg-muted/30 p-3">
          <p className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            <Smartphone className="h-3.5 w-3.5" /> Recipient preview
          </p>
          <div className="rounded-md bg-background p-3">
            {resolved.trim() ? (
              <span className="inline-block max-w-[80%] whitespace-pre-wrap break-words rounded-2xl rounded-bl-sm bg-success px-3 py-2 text-sm text-white">
                {resolved}
              </span>
            ) : (
              <span className="text-sm text-muted-foreground">Your message preview appears here…</span>
            )}
          </div>
        </div>
      )}

      {saving ? (
        <div className="flex flex-wrap items-center gap-2">
          <Input id="template-name" aria-label="Template name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Template name" className="w-48" />
          <Button size="sm" onClick={save} disabled={busy}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" />} Save
          </Button>
          <Button size="sm" variant="ghost" onClick={() => { setSaving(false); setName("") }}>Cancel</Button>
        </div>
      ) : (
        <button type="button" onClick={() => setSaving(true)} className="flex items-center gap-1.5 text-sm text-primary hover:underline">
          <Copy className="h-4 w-4" /> Save as template
        </button>
      )}
    </div>
  )
}
