"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { AlertTriangle, Bot, ChevronDown, Loader2 } from "lucide-react"
import { supabase } from "@/lib/supabase"
import { cn } from "@/lib/utils"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { AUTO_FULFIL_NETWORKS, type AutoFulfilSettings, type RetryBucket } from "@/lib/auto-fulfil/settings"
import {
  describeLastRun,
  draftToSettings,
  networkSkipNotes,
  RETRY_BUCKETS,
  settingsToDraft,
  type PanelLastRun,
  type PanelSwitches,
  type SettingsDraft,
} from "@/lib/auto-fulfil/panel-format"
import { FAILURE_REASON_LABELS } from "@/lib/order-queue/failure-reason"

const POLL_MS = 30_000
const ENDPOINT = "/api/admin/auto-fulfil"

export const SWITCH_LABEL = "Auto-fulfil pending orders"
export const turnOnCopy = (minAgeMinutes: number) =>
  `Orders older than ${minAgeMinutes} minutes will be sent to suppliers automatically. Turn on?`

type PanelState = {
  settings: AutoFulfilSettings
  valid: boolean
  switches: PanelSwitches
  lastRun: PanelLastRun | null
  waitingAutoRows: number
}

async function authHeaders(): Promise<Record<string, string>> {
  const { data: { session } } = await supabase.auth.getSession()
  return session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}
}

function errorText(status: number, error: unknown): string {
  if (status === 403 && error === "admin_user_required") return "Only a signed-in admin can change these settings."
  if (status === 400 && typeof error === "string") return error
  return typeof error === "string" && error ? error : "Something went wrong. Try again."
}

async function callApi(init?: RequestInit): Promise<PanelState> {
  const res = await fetch(ENDPOINT, {
    ...init,
    headers: { ...(init?.headers ?? {}), ...(await authHeaders()) },
    cache: "no-store",
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok || !body?.settings) throw new Error(errorText(res.status, body?.error))
  return body as PanelState
}

export function AutoFulfilPanel() {
  const [state, setState] = useState<PanelState | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [draft, setDraft] = useState<SettingsDraft | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [switchError, setSwitchError] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [now, setNow] = useState(() => new Date())

  // Refs so the poll sees the latest values without restarting the interval.
  const dirtyRef = useRef(false)
  const savingRef = useRef(false)
  // Every request takes a ticket; a reply older than the newest accepted one is dropped (a slow poll must not undo a save).
  const ticketRef = useRef(0)
  const appliedRef = useRef(0)

  const apply = useCallback((ticket: number, next: PanelState, replaceForm: boolean) => {
    if (ticket < appliedRef.current) return
    appliedRef.current = ticket
    setState(next)
    setLoadError(null)
    setNow(new Date())
    if (replaceForm || !dirtyRef.current) {
      setDraft(settingsToDraft(next.settings))
      dirtyRef.current = false
    }
  }, [])

  const load = useCallback(async () => {
    if (savingRef.current) return
    const ticket = ++ticketRef.current
    try {
      apply(ticket, await callApi(), false)
    } catch (e) {
      if (ticket >= appliedRef.current) setLoadError(e instanceof Error ? e.message : "Could not load auto-fulfil")
    }
  }, [apply])

  useEffect(() => {
    load()
    const id = setInterval(load, POLL_MS)
    return () => clearInterval(id)
  }, [load])

  /** PUT the full object. Returns the error text, or null on success. */
  const save = useCallback(
    async (value: AutoFulfilSettings, replaceForm: boolean): Promise<string | null> => {
      savingRef.current = true
      setSaving(true)
      const ticket = ++ticketRef.current
      try {
        apply(ticket, await callApi({ method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) }), replaceForm)
        return null
      } catch (e) {
        return e instanceof Error ? e.message : "Could not save auto-fulfil settings"
      } finally {
        savingRef.current = false
        setSaving(false)
      }
    },
    [apply],
  )

  // The switch saves the stored settings with only `enabled` changed; unsaved form edits stay in the form.
  const setEnabled = async (enabled: boolean) => {
    if (!state) return
    setSwitchError(null)
    const err = await save({ ...structuredClone(state.settings), enabled }, false)
    if (err) setSwitchError(err)
  }

  const onSwitch = (checked: boolean) => {
    if (checked) setConfirmOpen(true)
    else setEnabled(false)
  }

  const onSaveSettings = async () => {
    if (!state || !draft) return
    setFormError(null)
    const parsed = draftToSettings(draft, state.settings.enabled)
    if (!parsed.ok) {
      setFormError(parsed.error)
      return
    }
    const err = await save(parsed.value, true)
    if (err) setFormError(err)
  }

  const editDraft = (next: SettingsDraft) => {
    dirtyRef.current = true
    setDraft(next)
  }

  const enabled = state?.settings.enabled ?? false
  const skipNotes = state ? networkSkipNotes(state.settings, state.switches) : []

  return (
    <Card className="border-primary/20">
      <CardHeader className="gap-3 sm:flex sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <CardTitle className="flex items-center gap-2 text-base">
            <Bot className="h-5 w-5 text-primary" />
            Auto-fulfil
          </CardTitle>
          <CardDescription>
            A cron that sends paid pending orders to suppliers once they are old enough, and retries the ones a supplier refused.
          </CardDescription>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          {saving && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
          <Label htmlFor="auto-fulfil-switch" className="text-sm font-medium">
            {SWITCH_LABEL}
          </Label>
          <Switch id="auto-fulfil-switch" checked={enabled} disabled={!state || saving} onCheckedChange={onSwitch} />
        </div>
      </CardHeader>

      <CardContent className="space-y-3">
        {loadError && (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>{loadError}</AlertDescription>
          </Alert>
        )}
        {switchError && (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>{switchError}</AlertDescription>
          </Alert>
        )}

        {!state && !loadError && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </p>
        )}

        {state && (
          <>
            <div className="flex flex-col gap-1 text-sm sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-4">
              <span className={cn("font-medium", enabled ? "text-primary" : "text-muted-foreground")}>
                {enabled ? "On" : "Off"}
              </span>
              <span className="text-muted-foreground">{describeLastRun(state.lastRun, now)}</span>
              <span className="text-muted-foreground">
                {state.waitingAutoRows} automatic {state.waitingAutoRows === 1 ? "order" : "orders"} waiting in the queue
              </span>
            </div>

            {!state.valid && (
              <Alert variant="destructive">
                <AlertTriangle className="h-4 w-4" />
                <AlertDescription>
                  The saved auto-fulfil settings are invalid or could not be read, so auto-fulfil is off. Check the
                  settings below and save them to fix this.
                </AlertDescription>
              </Alert>
            )}

            {skipNotes.length > 0 && (
              <ul className="space-y-0.5 text-sm text-muted-foreground">
                {skipNotes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            )}

            <Collapsible open={settingsOpen} onOpenChange={setSettingsOpen}>
              <CollapsibleTrigger asChild>
                <Button variant="outline" size="sm" className="gap-1">
                  Settings
                  <ChevronDown className={cn("h-4 w-4 transition-transform", settingsOpen && "rotate-180")} />
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent className="pt-4">
                {draft && (
                  <AutoFulfilSettingsForm
                    draft={draft}
                    onChange={editDraft}
                    saving={saving}
                    error={formError}
                    onSave={onSaveSettings}
                  />
                )}
              </CollapsibleContent>
            </Collapsible>
          </>
        )}
      </CardContent>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Turn on auto-fulfil?</AlertDialogTitle>
            <AlertDialogDescription>{turnOnCopy(state?.settings.minAgeMinutes ?? 0)}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmOpen(false)
                setEnabled(true)
              }}
            >
              Turn on
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  )
}

export type AutoFulfilSettingsFormProps = {
  draft: SettingsDraft
  onChange: (next: SettingsDraft) => void
  saving: boolean
  error: string | null
  onSave: () => void
}

function NumberField(props: { id: string; label: string; hint: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="space-y-1">
      <Label htmlFor={props.id}>{props.label}</Label>
      <Input
        id={props.id}
        type="number"
        inputMode="numeric"
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        className="max-w-[10rem]"
      />
      <p className="text-xs text-muted-foreground">{props.hint}</p>
    </div>
  )
}

/** The settings form without the loading logic, so it can be static-rendered in tests. */
export function AutoFulfilSettingsForm({ draft, onChange, saving, error, onSave }: AutoFulfilSettingsFormProps) {
  const setRule = (b: RetryBucket, patch: Partial<SettingsDraft["rules"][RetryBucket]>) =>
    onChange({ ...draft, rules: { ...draft.rules, [b]: { ...draft.rules[b], ...patch } } })
  const toggleNetwork = (n: string) =>
    onChange({
      ...draft,
      networks: draft.networks.includes(n) ? draft.networks.filter((x) => x !== n) : [...draft.networks, n],
    })

  return (
    <div className="space-y-4">
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-4">
          <h3 className="text-sm font-semibold">General</h3>
          <NumberField
            id="af-min-age"
            label="Minimum order age (minutes)"
            hint="10 to 120 minutes. Younger orders are left alone in case they are still being sent."
            value={draft.minAgeMinutes}
            onChange={(v) => onChange({ ...draft, minAgeMinutes: v })}
          />
          <NumberField
            id="af-max-age"
            label="Maximum order age (days)"
            hint="1 to 30 days. Older orders are left for you."
            value={draft.maxAgeDays}
            onChange={(v) => onChange({ ...draft, maxAgeDays: v })}
          />
          <NumberField
            id="af-per-run"
            label="Orders per run"
            hint="1 to 100."
            value={draft.perRun}
            onChange={(v) => onChange({ ...draft, perRun: v })}
          />
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Networks</legend>
            {AUTO_FULFIL_NETWORKS.map((n) => {
              const id = `af-net-${n.replace(/[^a-z0-9]/gi, "-")}`
              return (
                <div key={n} className="flex items-center gap-2">
                  <Checkbox id={id} checked={draft.networks.includes(n)} onCheckedChange={() => toggleNetwork(n)} />
                  <Label htmlFor={id} className="font-normal">
                    {n}
                  </Label>
                </div>
              )
            })}
          </fieldset>
        </div>

        <div className="space-y-2">
          <h3 className="text-sm font-semibold">Retry after a supplier refuses</h3>
          <p className="text-xs text-muted-foreground">Wait 1 to 10080 minutes. Tries 1 to 20.</p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="py-2 pr-2 font-medium">Supplier said</th>
                  <th className="py-2 pr-2 font-medium">Retry</th>
                  <th className="py-2 pr-2 font-medium">Wait (min)</th>
                  <th className="py-2 font-medium">Max tries</th>
                </tr>
              </thead>
              <tbody>
                {RETRY_BUCKETS.map((b) => {
                  const r = draft.rules[b]
                  return (
                    <tr key={b} className="border-b last:border-0">
                      <td className="py-2 pr-2">{FAILURE_REASON_LABELS[b]}</td>
                      <td className="py-2 pr-2">
                        <Switch
                          aria-label={`Retry: ${FAILURE_REASON_LABELS[b]}`}
                          checked={r.retry}
                          onCheckedChange={(v) => setRule(b, { retry: v })}
                        />
                      </td>
                      <td className="py-2 pr-2">
                        <Input
                          type="number"
                          inputMode="numeric"
                          aria-label={`Wait minutes: ${FAILURE_REASON_LABELS[b]}`}
                          value={r.waitMinutes}
                          disabled={!r.retry}
                          onChange={(e) => setRule(b, { waitMinutes: e.target.value })}
                          className="w-24"
                        />
                      </td>
                      <td className="py-2">
                        <Input
                          type="number"
                          inputMode="numeric"
                          aria-label={`Max tries: ${FAILURE_REASON_LABELS[b]}`}
                          value={r.maxTries}
                          disabled={!r.retry}
                          onChange={(e) => setRule(b, { maxTries: e.target.value })}
                          className="w-20"
                        />
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <Button onClick={onSave} disabled={saving}>
        {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
        Save settings
      </Button>
    </div>
  )
}
