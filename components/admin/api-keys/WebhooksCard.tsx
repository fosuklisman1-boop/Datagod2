"use client"

// Release 6 admin Overview card: the API webhooks switch (off at ship) with endpoints set up and today's deliveries.
import { useCallback, useEffect, useState } from "react"
import { Loader2, Webhook } from "lucide-react"
import { cn } from "@/lib/utils"
import { adminFetch } from "./admin-fetch"
import { ConfirmAction } from "./ConfirmAction"
import { Eyebrow, IconChip, InlineError, Panel } from "./ui"

export interface WebhookSettingsView {
  enabled: boolean
  updatedAt: string | null
  endpoints: number
  today: { pending: number; delivered: number; failed: number }
}
type Notice = { kind: "ok" | "error"; text: string } | null

export function WebhooksCardView(p: {
  settings: WebhookSettingsView | null
  loading: boolean
  error: string | null
  notice: Notice
  busy: boolean
  onToggle: (next: boolean) => Promise<boolean>
  onRetry: () => void
}) {
  const s = p.settings
  return (
    <Panel className="space-y-4">
      <div className="flex items-start gap-3">
        <IconChip icon={Webhook} />
        <div>
          <Eyebrow>Release 6</Eyebrow>
          <h3 className="text-base font-bold text-foreground">Webhooks</h3>
          {s && (
            <p className="text-xs text-muted-foreground">
              {s.endpoints === 1 ? "1 developer" : `${s.endpoints} developers`} with a URL · today {s.today.delivered} delivered, {s.today.failed} failed, {s.today.pending} waiting
            </p>
          )}
        </div>
      </div>
      {p.loading && !s ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" aria-hidden /> Loading</p>
      ) : p.error && !s ? (
        <InlineError message={p.error} onRetry={p.onRetry} />
      ) : s ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border p-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <p className="text-sm font-bold text-foreground">Order webhooks</p>
              <span
                className={cn(
                  "rounded-full border px-2 py-0.5 text-[11px] font-bold",
                  s.enabled ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" : "border-border text-muted-foreground",
                )}
              >
                {s.enabled ? "On" : "Off"}
              </span>
            </div>
            <p className="text-xs text-muted-foreground">Developers get a signed POST when a live order completes, fails or is refunded.</p>
          </div>
          <ConfirmAction
            trigger={
              <button type="button" disabled={p.busy} className="h-9 rounded-xl border border-border px-3 text-sm font-semibold disabled:opacity-60">
                {s.enabled ? "Switch off" : "Switch on"}
              </button>
            }
            title={s.enabled ? "Switch webhooks off?" : "Switch webhooks on?"}
            description={
              <p>
                {s.enabled
                  ? "No new events are sent. Queued events wait and go out if you switch back on. Developers lose the Webhooks tab."
                  : "Developers see a Webhooks tab and can save a URL. Every minute, finished live orders are sent to their URLs, signed, with retries."}
              </p>
            }
            confirmLabel={s.enabled ? "Switch off" : "Switch on"}
            onConfirm={() => p.onToggle(!s.enabled)}
          />
        </div>
      ) : null}
      {s && p.error && <InlineError message={p.error} onRetry={p.onRetry} />}
      {p.notice && (
        <p role={p.notice.kind === "error" ? "alert" : "status"} className={cn("text-xs font-semibold", p.notice.kind === "error" ? "text-rose-700 dark:text-rose-300" : "text-emerald-700 dark:text-emerald-300")}>
          {p.notice.text}
        </p>
      )}
    </Panel>
  )
}

export function WebhooksCard() {
  const [settings, setSettings] = useState<WebhookSettingsView | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice>(null)
  const load = useCallback(async () => {
    setLoading(true)
    const r = await adminFetch<WebhookSettingsView>("/api/admin/api-v2/webhook-settings", { cache: "no-store" })
    if (r.ok && r.data) setSettings(r.data)
    setError(r.ok ? null : r.error)
    setLoading(false)
  }, [])
  useEffect(() => {
    void load()
  }, [load])
  return (
    <WebhooksCardView
      settings={settings}
      loading={loading}
      error={error}
      notice={notice}
      busy={busy}
      onRetry={() => void load()}
      onToggle={async (next) => {
        if (busy) return false
        setBusy(true)
        setNotice(null)
        const r = await adminFetch("/api/admin/api-v2/webhook-settings", { method: "PUT", body: JSON.stringify({ enabled: next }) })
        setBusy(false)
        setNotice(r.ok ? { kind: "ok", text: `Webhooks switched ${next ? "on" : "off"}.` } : { kind: "error", text: r.error ?? "Could not save." })
        if (r.ok) setSettings((cur) => (cur ? { ...cur, enabled: next } : cur))
        await load()
        return r.ok
      }}
    />
  )
}
