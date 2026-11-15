"use client"

import { useEffect, useState } from "react"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { adminFetch, ApiError, TTB_API, type Settings } from "./api"
import { FIELD_LABELS, ttbErrorMessage } from "./format"

type TextSwitch = "airtimeEnabled" | "resultsCheckerEnabled" | "shopEnabled" | "callsEnabled"
type IntField = Exclude<keyof Settings, "mainEnabled" | "mainNumber" | "shopNumber" | "replySenderId" | "shopReplySenderId" | "aiEnabled" | "unclearRepliesEnabled" | TextSwitch>

// The text switches save on their own (turning one on needs the confirm dialog), so they are not part of Form.
const TEXT_SWITCHES: { field: TextSwitch; service: string; from: string; hint: string; confirmText?: string }[] = [
  {
    field: "airtimeEnabled", service: "airtime", from: "the main number",
    hint: "Customers text e.g. airtime 10. Uses the airtime fees, limits and per-network switches; a network off there stays off here.",
  },
  {
    field: "resultsCheckerEnabled", service: "checkers", from: "the main number",
    hint: "Customers text e.g. 2 wassce. Uses checker prices, bulk price and stock; a board off there stays off here. PINs go to the number that texted.",
  },
  {
    field: "shopEnabled", service: "shop data", from: "the shop number",
    hint: "Customers text a shop code and a size to the shop number. Each shop pays for its own replies from its SMS credits. Needs the shop number below and a distinct shop forwarder secret.",
  },
  {
    field: "callsEnabled", service: "missed calls", from: "the main and shop numbers",
    hint: "Texts people who miss-call the main or shop number: the support WhatsApp line, or their shop owner's number (1 shop credit).",
    confirmText: "This texts people who miss-call the main number or the shop number: the support WhatsApp line, or their shop owner's number (1 shop credit). Do a supervised test call first.",
  },
]
type Form = {mainNumber: string; shopNumber: string; replySenderId: string; shopReplySenderId: string; aiEnabled: boolean; unclearRepliesEnabled: boolean } & Record<IntField, string>

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
  { field: "shopRepliesPerHourPerShop", min: 5, max: 1000, hint: "Replies per hour to one shop's customers on the shop line. At the cap that shop goes quiet." },
  { field: "callsPerHourPerLine", min: 5, max: 500, hint: "Missed-call texts per hour on each of the main and shop numbers. At the cap further calls get no text." },
]

const SENDER_ID_HINT =
  "The name or number customers see replies come from. Up to 11 letters, digits or spaces. Some SMS providers only deliver sender IDs they have approved, so send yourself a test reply on MTN, Telecel and AT before relying on it. Leave empty to use the platform default."

const toForm = (s: Settings): Form => ({
  mainNumber: s.mainNumber,
  shopNumber: s.shopNumber,
  shopRepliesPerHourPerShop: String(s.shopRepliesPerHourPerShop),
  callsPerHourPerLine: String(s.callsPerHourPerLine),
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
  const [pendingSwitch, setPendingSwitch] = useState<TextSwitch | null>(null) // the switch whose confirm dialog is open
  const [switchBusy, setSwitchBusy] = useState(false)
  const [switchError, setSwitchError] = useState<string | null>(null)

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
    if (f.shopNumber !== saved.shopNumber) body.shopNumber = f.shopNumber
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

  async function applySwitch(field: TextSwitch, value: boolean) {
    setSwitchBusy(true)
    setSwitchError(null)
    try {
      await adminFetch(TTB_API, { method: "PUT", body: value ? { [field]: true, confirm: true } : { [field]: false } })
      setPendingSwitch(null)
      toast.success(`${FIELD_LABELS[field]} is ${value ? "on" : "off"}`)
      onSaved()
    } catch (e) {
      const msg = ttbErrorMessage(e instanceof ApiError ? e.code : undefined)
      if (value) setSwitchError(msg)
      else toast.error(msg)
    } finally {
      setSwitchBusy(false)
    }
  }

  const pendingInfo = TEXT_SWITCHES.find((s) => s.field === pendingSwitch)

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
            <div className="space-y-1">
              <label className="text-xs font-medium" htmlFor="ttb-shopNumber">{FIELD_LABELS.shopNumber}</label>
              <Input id="ttb-shopNumber" inputMode="tel" value={f.shopNumber} onChange={(e) => patch({ shopNumber: e.target.value })} aria-invalid={errField === "shopNumber"} />
              <p className="text-[11px] text-muted-foreground">A Ghana mobile number, or empty. The number shop customers text.</p>
              {fieldErr("shopNumber")}
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

            {TEXT_SWITCHES.map(({ field, hint }) => (
              <div key={field} className="flex items-start justify-between gap-3 lg:col-span-2">
                <div>
                  <label className="text-sm font-medium" htmlFor={`ttb-${field}`}>{FIELD_LABELS[field]}</label>
                  <p className="text-xs text-muted-foreground">{hint}</p>
                </div>
                <Switch
                  id={`ttb-${field}`}
                  checked={settings[field]}
                  disabled={defaulted || switchBusy}
                  onCheckedChange={(v) => {
                    if (v) {
                      setSwitchError(null)
                      setPendingSwitch(field)
                    } else void applySwitch(field, false)
                  }}
                  aria-label={FIELD_LABELS[field]}
                />
              </div>
            ))}

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

      <Dialog open={pendingSwitch !== null} onOpenChange={(o) => !o && !switchBusy && setPendingSwitch(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Turn on {pendingSwitch ? FIELD_LABELS[pendingSwitch] : ""}?</DialogTitle>
            <DialogDescription>
              {pendingInfo?.confirmText ?? `Customers can buy ${pendingInfo?.service} by text from ${pendingInfo?.from}. Do a supervised paid test first.`}
            </DialogDescription>
          </DialogHeader>
          {switchError && <p className="text-sm text-red-600 dark:text-red-400" role="alert">{switchError}</p>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingSwitch(null)} disabled={switchBusy}>Cancel</Button>
            <Button onClick={() => pendingSwitch && void applySwitch(pendingSwitch, true)} disabled={switchBusy}>
              {switchBusy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Turn on
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
