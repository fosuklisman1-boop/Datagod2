"use client"

import { useCallback, useEffect, useState } from "react"
import { CalendarClock, Loader2, Megaphone, Undo2, UserMinus, UserPlus } from "lucide-react"
import { toast } from "sonner"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { formatGhanaDate, isEarlierThanNotice, isoToPicker, isUuid, pickerToIso } from "@/lib/api-v1/retirement-ui"
import { adminFetch } from "./admin-fetch"
import { ConfirmAction } from "./ConfirmAction"
import { Eyebrow, IconChip, InlineError, Panel } from "./ui"

export interface RetirementExemptUser {
  id: string
  email: string | null
  phone: string | null
  first_name: string | null
}
export interface RetirementStraggler {
  user_id: string
  email: string | null
  last_call: string | null
  calls_7d: number
  orders_7d: number
  exempt: boolean
}
export interface RetirementData {
  sunset_at: string | null
  exempt_users: RetirementExemptUser[]
  notice_sent_at: string | null
  stragglers: RetirementStraggler[]
}

const BTN = "inline-flex h-9 items-center justify-center gap-2 rounded-lg px-3 text-sm font-semibold disabled:opacity-60"
const PRIMARY_BTN = cn(BTN, "bg-primary text-primary-foreground hover:bg-primary/90")
const OUTLINE_BTN = cn(BTN, "border border-border text-foreground hover:bg-muted")

function fmt(iso: string | null): string {
  return iso ? formatGhanaDate(new Date(iso)) : "-"
}

export interface V1RetirementCardViewProps {
  data: RetirementData
  /** Any request in flight: disables every action. */
  busy: boolean
  error: string | null
  /** Set after a notify 409: the notice was already sent at this time. */
  resendSentAt: string | null
  /** Result line of the last notify. */
  notifyResult: string | null
  now?: Date
  onSave: (sunsetAt: string | null, exemptIds: string[]) => Promise<unknown>
  onNotify: (confirmResend: boolean) => Promise<unknown>
}

/** Presentational card; the data owner is V1RetirementCard. */
export function V1RetirementCardView(p: V1RetirementCardViewProps) {
  const { data, busy } = p
  const [picker, setPicker] = useState(isoToPicker(data.sunset_at))
  const [pasted, setPasted] = useState("")
  const [pasteError, setPasteError] = useState<string | null>(null)

  useEffect(() => setPicker(isoToPicker(data.sunset_at)), [data.sunset_at])

  const iso = picker ? pickerToIso(picker) : null
  const pickerInvalid = picker !== "" && iso === null
  const early = iso !== null && isEarlierThanNotice(iso, p.now ?? new Date())
  const exemptIds = data.exempt_users.map((u) => u.id)
  const unchanged = iso === data.sunset_at

  const save = () => p.onSave(iso, exemptIds)
  const setExempt = (ids: string[]) => p.onSave(data.sunset_at, ids)

  const addPasted = async () => {
    const id = pasted.trim().toLowerCase()
    if (!isUuid(id)) {
      setPasteError("Paste a user id (UUID), or use the Exempt button in the table below.")
      return
    }
    setPasteError(null)
    if (!exemptIds.includes(id)) await setExempt([...exemptIds, id])
    setPasted("")
  }

  const saveButton = (
    <button
      type="button"
      disabled={busy || !iso || pickerInvalid || unchanged}
      onClick={early ? undefined : () => void save()}
      className={PRIMARY_BTN}
    >
      {busy && <Loader2 className="size-4 animate-spin" aria-hidden />}
      Save retirement date
    </button>
  )

  return (
    <Panel className="space-y-5">
      <div className="flex items-start gap-3">
        <IconChip icon={CalendarClock} />
        <div className="min-w-0">
          <Eyebrow>Legacy API v1</Eyebrow>
          <h2 className="text-base font-bold text-foreground">Retire API v1</h2>
          <p className="text-sm text-muted-foreground">
            {data.sunset_at ? (
              <>
                Retires on <span className="font-semibold text-foreground">{fmt(data.sunset_at)}</span>. After that v1
                requests are refused (exempt users excepted).
              </>
            ) : (
              "No date set: v1 keeps working normally."
            )}
          </p>
        </div>
      </div>

      {p.error && <InlineError message={p.error} />}

      <div className="grid gap-5 lg:grid-cols-2">
        {/* Date and notify */}
        <div className="space-y-3">
          <label htmlFor="v1-sunset" className="block text-sm font-semibold text-foreground">
            Retirement date and time (GMT)
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              id="v1-sunset"
              type="datetime-local"
              value={picker}
              onChange={(e) => setPicker(e.target.value)}
              aria-invalid={pickerInvalid}
              className="h-9 w-full rounded-lg bg-background sm:w-60"
            />
            <span className="text-xs text-muted-foreground">GMT (same as Ghana time)</span>
          </div>
          {pickerInvalid && <p className="text-xs text-destructive">That is not a valid date and time.</p>}
          <div className="flex flex-wrap gap-2">
            {early ? (
              <ConfirmAction
                trigger={saveButton}
                title="Set a retirement date under 14 days away?"
                description={
                  <p>
                    {fmt(iso)} is less than 14 days from now. Integrators get very little time to move to v2. Continue?
                  </p>
                }
                confirmLabel="Set date anyway"
                onConfirm={save}
              />
            ) : (
              saveButton
            )}
            {data.sunset_at && (
              <button type="button" disabled={busy} onClick={() => void p.onSave(null, exemptIds)} className={OUTLINE_BTN}>
                <Undo2 className="size-4" aria-hidden />
                Clear date (undo)
              </button>
            )}
          </div>

          <div className="space-y-2 border-t border-border pt-3">
            <p className="text-sm font-semibold text-foreground">Notify v1 users</p>
            <p className="text-xs text-muted-foreground">
              Sends the retirement notice by SMS and email to everyone with an active v1 key.
              {data.notice_sent_at && <> Last sent {fmt(data.notice_sent_at)}.</>}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <ConfirmAction
                trigger={
                  <button type="button" disabled={busy || !data.sunset_at} className={OUTLINE_BTN}>
                    {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Megaphone className="size-4" aria-hidden />}
                    Notify v1 users
                  </button>
                }
                title="Send the retirement notice now?"
                description={<p>Every active v1 key owner gets an SMS and an email about the {fmt(data.sunset_at)} retirement.</p>}
                confirmLabel="Send notice"
                onConfirm={() => p.onNotify(false)}
              />
              {!data.sunset_at && <span className="text-xs text-muted-foreground">Set a date first.</span>}
            </div>
            {p.resendSentAt && (
              <div role="alert" className="space-y-2 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
                <p>The notice was already sent on {fmt(p.resendSentAt)}. Send it again?</p>
                <button type="button" disabled={busy} onClick={() => void p.onNotify(true)} className={PRIMARY_BTN}>
                  {busy && <Loader2 className="size-4 animate-spin" aria-hidden />}
                  Yes, resend
                </button>
              </div>
            )}
            {p.notifyResult && <p className="text-xs text-muted-foreground">{p.notifyResult}</p>}
          </div>
        </div>

        {/* Exempt users */}
        <div className="space-y-3">
          <p className="text-sm font-semibold text-foreground">Exempt users ({data.exempt_users.length})</p>
          <p className="text-xs text-muted-foreground">
            Exempt users keep v1 access after the date. Add one with the Exempt button in the table below, or paste a user id.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor="v1-exempt-id" className="sr-only">
              User id to exempt
            </label>
            <Input
              id="v1-exempt-id"
              value={pasted}
              onChange={(e) => setPasted(e.target.value)}
              placeholder="User id (UUID)"
              className="h-9 min-w-0 flex-1 rounded-lg bg-background font-mono text-xs"
            />
            <button type="button" disabled={busy || !pasted.trim()} onClick={() => void addPasted()} className={OUTLINE_BTN}>
              <UserPlus className="size-4" aria-hidden />
              Add
            </button>
          </div>
          {pasteError && <p className="text-xs text-destructive">{pasteError}</p>}
          {data.exempt_users.length === 0 ? (
            <p className="text-sm text-muted-foreground">No exempt users.</p>
          ) : (
            <ul className="divide-y divide-border rounded-xl border border-border">
              {data.exempt_users.map((u) => (
                <li key={u.id} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
                  <span className="min-w-0">
                    <span className="block truncate font-medium text-foreground">{u.first_name || u.email || u.id}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {[u.email, u.phone].filter(Boolean).join(" · ")}
                    </span>
                  </span>
                  <button
                    type="button"
                    disabled={busy}
                    aria-label={`Remove ${u.email ?? u.id} from exempt users`}
                    onClick={() => void setExempt(exemptIds.filter((i) => i !== u.id))}
                    className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg border border-border text-muted-foreground hover:bg-muted disabled:opacity-60"
                  >
                    <UserMinus className="size-4" aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* Stragglers */}
      <div className="space-y-2">
        <p className="text-sm font-semibold text-foreground">Still calling v1 (last 7 days)</p>
        {data.stragglers.length === 0 ? (
          <p className="text-sm text-muted-foreground">No v1 calls in the last 7 days.</p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full text-left text-sm">
              <thead className="bg-muted/60 text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-semibold">User</th>
                  <th className="px-3 py-2 font-semibold">Last call</th>
                  <th className="px-3 py-2 text-right font-semibold">Calls</th>
                  <th className="px-3 py-2 text-right font-semibold">Orders</th>
                  <th className="px-3 py-2 text-right font-semibold">Exempt</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {data.stragglers.map((s) => (
                  <tr key={s.user_id}>
                    <td className="max-w-[14rem] truncate px-3 py-2 text-foreground">{s.email ?? s.user_id}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">{fmt(s.last_call)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{s.calls_7d}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{s.orders_7d}</td>
                    <td className="px-3 py-2 text-right">
                      {s.exempt ? (
                        <span className="text-xs font-semibold text-primary">Exempt</span>
                      ) : (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void setExempt([...exemptIds, s.user_id])}
                          className="rounded-lg border border-border px-2 py-1 text-xs font-semibold hover:bg-muted disabled:opacity-60"
                        >
                          Exempt
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Panel>
  )
}

/** Loads and saves the v1 retirement settings. */
export function V1RetirementCard() {
  const [data, setData] = useState<RetirementData | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [resendSentAt, setResendSentAt] = useState<string | null>(null)
  const [notifyResult, setNotifyResult] = useState<string | null>(null)

  const load = useCallback(async (): Promise<RetirementData | null> => {
    const r = await adminFetch<RetirementData>("/api/admin/api-v1/retirement")
    if (r.ok && r.data) {
      setData(r.data)
      setLoadError(null)
      return r.data
    }
    setLoadError(r.error)
    return null
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const onSave = async (sunsetAt: string | null, exemptIds: string[]) => {
    setBusy(true)
    setError(null)
    const r = await adminFetch<unknown>("/api/admin/api-v1/retirement", {
      method: "PUT",
      body: JSON.stringify({ sunset_at: sunsetAt, exempt_user_ids: exemptIds }),
    })
    if (r.ok) {
      toast.success("Retirement settings saved")
      await load()
    } else setError(r.error)
    setBusy(false)
  }

  const onNotify = async (confirmResend: boolean) => {
    setBusy(true)
    setError(null)
    setNotifyResult(null)
    const r = await adminFetch<{ sms_sent: number; email_sent: number; failed: number }>(
      "/api/admin/api-v1/retirement/notify",
      { method: "POST", body: JSON.stringify(confirmResend ? { confirm_resend: true } : {}) }
    )
    if (r.ok && r.data) {
      setResendSentAt(null)
      setNotifyResult(`Sent ${r.data.sms_sent} SMS and ${r.data.email_sent} emails; ${r.data.failed} failed.`)
      await load()
    } else if (r.status === 409) {
      // adminFetch drops the 409 body, so the sent time comes from the settings (notice_sent_at).
      const fresh = await load()
      setResendSentAt(fresh?.notice_sent_at ?? new Date().toISOString())
    } else setError(r.error)
    setBusy(false)
  }

  if (loadError) return <InlineError message={`Retirement settings could not be loaded: ${loadError}`} onRetry={() => void load()} />
  if (!data)
    return (
      <Panel>
        <p className="text-sm text-muted-foreground">Loading retirement settings...</p>
      </Panel>
    )
  return (
    <V1RetirementCardView
      data={data}
      busy={busy}
      error={error}
      resendSentAt={resendSentAt}
      notifyResult={notifyResult}
      onSave={onSave}
      onNotify={onNotify}
    />
  )
}
