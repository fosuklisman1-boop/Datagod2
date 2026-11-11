"use client"

import { useEffect, useState } from "react"
import { Loader2, Plus, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { adminErrorMessage, FIELD_LABELS } from "@/lib/momo-claim/admin-view"
import { adminFetch, ApiError, MOMO_API, type Settings } from "./api"

type Form = {
  enabled: boolean
  accounts: Settings["accounts"]
  accountName: string
  feeCustomerPercent: string
  feeDealerPercent: string
  minNet: string
  maxSent: string
  senderAllowlist: string
  regressionThreshold: string
  reviewThreshold: string
  dailyCap: string
}

const toForm = (s: Settings): Form => ({
  enabled: s.enabled,
  accounts: s.accounts.map((a) => ({ ...a })),
  accountName: s.accountName,
  feeCustomerPercent: String(s.feeCustomerPercent),
  feeDealerPercent: String(s.feeDealerPercent),
  minNet: s.minNet.toFixed(2),
  maxSent: s.maxSent.toFixed(2),
  senderAllowlist: s.senderAllowlist.join(", "),
  regressionThreshold: String(s.regressionThreshold),
  reviewThreshold: s.reviewThreshold.toFixed(2),
  dailyCap: s.dailyCap.toFixed(2),
})

// Empty strings become NaN-safe values the API rejects with a field error rather than silently becoming 0.
const num = (v: string) => (v.trim() === "" ? null : Number(v))

function FieldError({ field, errField, message }: { field: string; errField: string | null; message: string | null }) {
  if (errField !== field || !message) return null
  return <p className="mt-1 text-xs text-red-600 dark:text-red-400" role="alert">{message}</p>
}

export function SettingsTab({ settings, defaulted, onSaved }: { settings: Settings | null; defaulted: boolean; onSaved: () => void }) {
  const [form, setForm] = useState<Form | null>(settings ? toForm(settings) : null)
  const [busy, setBusy] = useState(false)
  const [errField, setErrField] = useState<string | null>(null)
  const [errMsg, setErrMsg] = useState<string | null>(null)

  useEffect(() => {
    if (settings) setForm(toForm(settings))
  }, [settings])

  if (!form) return <p className="text-sm text-muted-foreground">Loading settings...</p>
  const f = form
  const patch = (p: Partial<Form>) => setForm({ ...f, ...p })
  const hasMtn = f.accounts.some((a) => a.network === "MTN")
  const fieldLabel = errField ? FIELD_LABELS[errField] ?? errField : null

  async function save() {
    setBusy(true)
    setErrField(null)
    setErrMsg(null)
    try {
      await adminFetch(MOMO_API, {
        method: "POST",
        body: {
          enabled: f.enabled,
          accounts: f.accounts,
          accountName: f.accountName,
          feeCustomerPercent: num(f.feeCustomerPercent),
          feeDealerPercent: num(f.feeDealerPercent),
          minNet: num(f.minNet),
          maxSent: num(f.maxSent),
          senderAllowlist: f.senderAllowlist.split(",").map((s) => s.trim()).filter(Boolean),
          regressionThreshold: num(f.regressionThreshold),
          reviewThreshold: num(f.reviewThreshold),
          dailyCap: num(f.dailyCap),
        },
      })
      toast.success("Settings saved")
      onSaved()
    } catch (e) {
      const code = e instanceof ApiError ? e.code : undefined
      setErrField(e instanceof ApiError && e.field ? e.field : "_form")
      setErrMsg(code && code !== "invalid_setting" ? adminErrorMessage(code) : `Check the ${fieldLabel ?? "highlighted"} value.`)
    } finally {
      setBusy(false)
    }
  }

  const row = (label: string, field: keyof Form, hint?: string, mode: "decimal" | "numeric" = "decimal") => (
    <div className="space-y-1">
      <label className="text-xs font-medium" htmlFor={`st-${field}`}>{label}</label>
      <Input id={`st-${field}`} inputMode={mode} value={f[field] as string} onChange={(e) => patch({ [field]: e.target.value } as Partial<Form>)} aria-invalid={errField === field} />
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
      <FieldError field={field} errField={errField} message={errMsg} />
    </div>
  )

  return (
    <div className="space-y-4">
      {defaulted && (
        <div className="rounded-md border border-red-300 bg-red-50 p-3 text-sm font-medium text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300" role="alert">
          Settings could not be loaded — saving is disabled to avoid resetting them.
        </div>
      )}
      <Card>
        <CardContent className="space-y-5 pt-6">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-sm font-medium">Send &amp; Claim enabled</div>
              <p className="text-xs text-muted-foreground">Customers can only generate payment codes while this is on.</p>
            </div>
            <Switch checked={f.enabled} onCheckedChange={(v) => patch({ enabled: v })} aria-label="Enabled" />
          </div>
          {f.enabled && !hasMtn && (
            <p className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
              {adminErrorMessage("mtn_account_required")}
            </p>
          )}
          <FieldError field="enabled" errField={errField} message={errMsg} />

          <div className="space-y-2">
            <div className="text-sm font-medium">Payment accounts</div>
            {f.accounts.map((a, i) => (
              <div key={i} className="flex gap-2">
                <select
                  className="h-9 rounded-md border bg-background px-2 text-sm"
                  value={a.network}
                  aria-label="Network"
                  onChange={(e) => patch({ accounts: f.accounts.map((x, j) => (j === i ? { ...x, network: e.target.value as Settings["accounts"][number]["network"] } : x)) })}
                >
                  <option>MTN</option>
                  <option>Telecel</option>
                  <option>AirtelTigo</option>
                </select>
                <Input
                  value={a.number}
                  inputMode="numeric"
                  maxLength={10}
                  placeholder="0241234567"
                  aria-label="Account number"
                  onChange={(e) => patch({ accounts: f.accounts.map((x, j) => (j === i ? { ...x, number: e.target.value } : x)) })}
                />
                <Button type="button" variant="outline" size="icon" aria-label="Remove account" onClick={() => patch({ accounts: f.accounts.filter((_, j) => j !== i) })}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}
            <Button type="button" variant="outline" size="sm" onClick={() => patch({ accounts: [...f.accounts, { network: "MTN", number: "" }] })}>
              <Plus className="mr-1 h-4 w-4" />Add account
            </Button>
            <FieldError field="accounts" errField={errField} message={errMsg} />
          </div>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div className="space-y-1">
              <label className="text-xs font-medium" htmlFor="st-accountName">Account name</label>
              <Input id="st-accountName" value={f.accountName} maxLength={80} onChange={(e) => patch({ accountName: e.target.value })} />
              <FieldError field="accountName" errField={errField} message={errMsg} />
            </div>
            {row("Customer fee (%)", "feeCustomerPercent")}
            {row("Dealer fee (%)", "feeDealerPercent")}
            {row("Minimum credit (GHS)", "minNet", "Smallest amount a customer receives after the fee.")}
            {row("Maximum per payment (GHS)", "maxSent")}
            {row("Old-ID threshold", "regressionThreshold", "How far behind the newest ID counts as old.", "numeric")}
            {row("Review threshold (GHS)", "reviewThreshold", "Auto-claims above this wait for approval.")}
            {row("Daily cap (GHS)", "dailyCap", "Auto-claims above this per user per day wait for approval.")}
            <div className="space-y-1 sm:col-span-2 lg:col-span-3">
              <label className="text-xs font-medium" htmlFor="st-senderAllowlist">SMS sender allow-list (comma separated)</label>
              <Input id="st-senderAllowlist" value={f.senderAllowlist} onChange={(e) => patch({ senderAllowlist: e.target.value })} />
              <FieldError field="senderAllowlist" errField={errField} message={errMsg} />
            </div>
          </div>

          {errField === "_form" && errMsg && <p className="text-sm text-red-600 dark:text-red-400" role="alert">{errMsg}</p>}

          <Button onClick={() => void save()} disabled={defaulted || busy}>
            {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Save settings
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}
