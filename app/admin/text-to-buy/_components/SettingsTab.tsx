"use client"

import { useEffect, useState } from "react"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { adminFetch, ApiError, TTB_API, type Settings } from "./api"
import { FIELD_LABELS, ttbErrorMessage } from "./format"

type IntField = Exclude<keyof Settings, "mainEnabled" | "mainNumber" | "replySenderId" | "shopReplySenderId" | "aiEnabled" | "unclearRepliesEnabled">
type Form = { mainNumber: string; replySenderId: string; shopReplySenderId: string; aiEnabled: boolean; unclearRepliesEnabled: boolean } & Record<IntField, string>

// Ranges mirror lib/text-to-buy/admin-validate.ts. The server is the authority; these are helper text.
const INT_FIELDS: { field: IntField; min: number; max: number; hint: string }[] = [
  { field: "staleMinutes", min: 1, max: 120, hint: "How long an unpaid prompt stays open." },
  { field: "promptsPerHour", min: 1, max: 20, hint: "MoMo prompts one phone can get per hour." },
  { field: "repliesPerHour", min: 1, max: 30, hint: "Replies one phone can get per hour." },
  { field: "aiReadsPerHour", min: 0, max: 60, hint: "AI reads per phone per hour. 0 turns AI reading off for everyone." },
  { field: "globalPromptsPerMinute", min: 1, max: 500, hint: "Prompts across all customers per minute." },
  { field: "promptWindowMinutes", min: 2, max: 30, hint: "How long a customer has to approve a prompt." },
  { field: "quietAlertMinutes", min: 10, max: 1440, hint: "Alert when the forwarding phone is silent this long." },
  { field: "retentionDays", min: 1, max: 90, hint: "Message text is deleted after this many days." },
  {
    field: "globalRepliesPerHour", min: 10, max: 5000,
    hint: "Stops help replies, questions and price lists once this many replies went out in the last hour. Order quotes and payment notices are never stopped.",
  },
]

const SENDER_ID_HINT =
  "The name or number customers see replies come from. Up to 11 letters, digits or spaces. Some SMS providers only deliver sender IDs they have approved, so send yourself a test reply on MTN, Telecel and AT before relying on it. Leave empty to use the platform default."

const toForm = (s: Settings): Form => ({
  mainNumber: s.mainNumber,
  replySenderId: s.replySenderId,
  shopReplySenderId: s.shopReplySenderId,
  aiEnabled: s.aiEnabled,
  unclearRepliesEnabled: s.unclearRepliesEnabled,
  globalRepliesPerHour: String(s.globalRepliesPerHour),
  staleMinutes: String(s.staleMinutes),
  promptsPerHour: String(s.promptsPerHour),
  repliesPerHour: String(s.repliesPerHour),
  aiReadsPerHour: String(s.aiReadsPerHour),
  globalPromptsPerMinute: String(s.globalPromptsPerMinute),
  promptWindowMinutes: String(s.promptWindowMinutes),
  quietAlertMinutes: String(s.quietAlertMinutes),
  retentionDays: String(s.retentionDays),
})

// An empty or non-numeric box becomes NaN, which the server rejects with a field error instead of becoming 0.
const num = (v: string) => (v.trim() === "" ? Number.NaN : Number(v))

export function SettingsTab({ settings, defaulted, onSaved }: { settings: Settings | null; defaulted: boolean; onSaved: () => void }) {
  const [form, setForm] = useState<Form | null>(settings ? toForm(settings) : null)
  const [busy, setBusy] = useState(false)
  const [errField, setErrField] = useState<string | null>(null)
  const [errMsg, setErrMsg] = useState<string | null>(null)

  useEffect(() => {
    if (settings) setForm(toForm(settings))
  }, [settings])

  if (!form || !settings) return <p className="text-sm text-muted-foreground">Loading settings...</p>
  const f = form
  const saved = toForm(settings)
  const dirty = (Object.keys(f) as (keyof Form)[]).some((k) => f[k] !== saved[k])
  const patch = (p: Partial<Form>) => setForm({ ...f, ...p })

  async function save() {
    setBusy(true)
    setErrField(null)
    setErrMsg(null)
    // Only the changed fields are sent. The on/off switch is on the Overview tab (it needs its own confirmation).
    const body: Record<string, unknown> = {}
    if (f.mainNumber !== saved.mainNumber) body.mainNumber = f.mainNumber
    if (f.replySenderId !== saved.replySenderId) body.replySenderId = f.replySenderId
    if (f.shopReplySenderId !== saved.shopReplySenderId) body.shopReplySenderId = f.shopReplySenderId
    if (f.aiEnabled !== saved.aiEnabled) body.aiEnabled = f.aiEnabled
    if (f.unclearRepliesEnabled !== saved.unclearRepliesEnabled) body.unclearRepliesEnabled = f.unclearRepliesEnabled
    for (const { field } of INT_FIELDS) if (f[field] !== saved[field]) body[field] = num(f[field])
    try {
      await adminFetch(TTB_API, { method: "PUT", body })
      toast.success("Settings saved")
      onSaved()
    } catch (e) {
      const code = e instanceof ApiError ? e.code : undefined
      const m = code ? /^invalid_(.+)$/.exec(code) : null
      if (m && m[1] in FIELD_LABELS) {
        setErrField(m[1])
        setErrMsg(`Check the "${FIELD_LABELS[m[1]]}" value.`)
      } else {
        setErrField("_form")
        setErrMsg(ttbErrorMessage(code))
      }
    } finally {
      setBusy(false)
    }
  }

  const fieldErr = (field: string) =>
    errField === field && errMsg ? <p className="mt-1 text-xs text-red-600 dark:text-red-400" role="alert">{errMsg}</p> : null

  return (
    <div className="space-y-4">
      {defaulted && (
        <div className="rounded-md border border-red-300 bg-red-50 p-3 text-sm font-medium text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300" role="alert">
          The saved settings could not be read, so saving is disabled to avoid overwriting them. Refresh to try again.
        </div>
      )}
      <Card>
        <CardContent className="space-y-5 pt-6">
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="space-y-1">
              <label className="text-xs font-medium" htmlFor="ttb-mainNumber">{FIELD_LABELS.mainNumber}</label>
              <Input id="ttb-mainNumber" inputMode="tel" value={f.mainNumber} onChange={(e) => patch({ mainNumber: e.target.value })} aria-invalid={errField === "mainNumber"} />
              <p className="text-[11px] text-muted-foreground">A Ghana mobile number, or empty. The number customers text.</p>
              {fieldErr("mainNumber")}
            </div>
            {(["replySenderId", "shopReplySenderId"] as const).map((field) => (
              <div key={field} className="space-y-1">
                <label className="text-xs font-medium" htmlFor={`ttb-${field}`}>{FIELD_LABELS[field]}</label>
                <Input id={`ttb-${field}`} value={f[field]} maxLength={11} onChange={(e) => patch({ [field]: e.target.value } as Partial<Form>)} aria-invalid={errField === field} />
                <p className="text-[11px] text-muted-foreground">{SENDER_ID_HINT}</p>
                {fieldErr(field)}
              </div>
            ))}

            <div className="flex items-start justify-between gap-3 lg:col-span-2">
              <div>
                <label className="text-sm font-medium" htmlFor="ttb-aiEnabled">{FIELD_LABELS.aiEnabled}</label>
                <p className="text-xs text-muted-foreground">When off, only the fixed rules read texts. Anything they cannot read gets a help reply.</p>
              </div>
              <Switch id="ttb-aiEnabled" checked={f.aiEnabled} onCheckedChange={(v) => patch({ aiEnabled: v })} aria-label={FIELD_LABELS.aiEnabled} />
            </div>

            <div className="flex items-start justify-between gap-3 lg:col-span-2">
              <div>
                <label className="text-sm font-medium" htmlFor="ttb-unclearRepliesEnabled">{FIELD_LABELS.unclearRepliesEnabled}</label>
                <p className="text-xs text-muted-foreground">When off, texts that are not orders get no reply, so unrelated or promotional texts cost nothing. A bare YES or AGAIN with nothing to act on counts as unclear.</p>
              </div>
              <Switch id="ttb-unclearRepliesEnabled" checked={f.unclearRepliesEnabled} onCheckedChange={(v) => patch({ unclearRepliesEnabled: v })} aria-label={FIELD_LABELS.unclearRepliesEnabled} />
            </div>

            {INT_FIELDS.map(({ field, min, max, hint }) => (
              <div key={field} className="space-y-1">
                <label className="text-xs font-medium" htmlFor={`ttb-${field}`}>{FIELD_LABELS[field]}</label>
                <Input id={`ttb-${field}`} inputMode="numeric" value={f[field]} onChange={(e) => patch({ [field]: e.target.value } as Partial<Form>)} aria-invalid={errField === field} />
                <p className="text-[11px] text-muted-foreground">Whole number, {min} to {max}. {hint}</p>
                {fieldErr(field)}
              </div>
            ))}
          </div>

          {errField === "_form" && errMsg && <p className="text-sm text-red-600 dark:text-red-400" role="alert">{errMsg}</p>}

          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={() => void save()} disabled={defaulted || busy || !dirty}>
              {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Save settings
            </Button>
            {dirty && <span className="text-xs text-amber-700 dark:text-amber-300">Unsaved changes</span>}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
