"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { Copy, Eye, RefreshCw, Send, Trash2, Webhook } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Eyebrow, IconChip, InlineError, Panel, TONE_CHIP, type Tone } from "@/components/admin/api-keys/ui"
import { latestGate, shortTime } from "@/lib/api-v2/dev-dashboard-view"
import { cn } from "@/lib/utils"
import { dashJson } from "./dash-fetch"

export interface WebhookInfo {
  enabled_globally: boolean
  endpoint: { url: string; enabled: boolean; secret_hint: string; created_at: string | null; updated_at: string | null } | null
}
interface AttemptRow {
  attempt: number
  at: string
  ok: boolean
  code: number | null
  duration_ms: number | null
  error: string | null
  snippet: string | null
}
export interface DeliveryRow {
  id: string
  type: string
  state: "pending" | "delivered" | "failed" | string
  attempts: number
  last_code: number | null
  last_error: string | null
  created_at: string
  next_attempt_at: string | null
  delivered_at: string | null
  payload: { data?: { reference?: string; status?: string; product?: string } } | null
  attempts_log: AttemptRow[]
}

const STATE_TONE: Record<string, Tone> = { delivered: "green", failed: "red", pending: "amber" }

export interface WebhooksViewProps {
  loading: boolean
  error: string | null
  info: WebhookInfo | null
  deliveries: DeliveryRow[]
  next: string | null
  busy: boolean
  shownSecret: string | null
  onSave(url: string): void
  onDelete(): void
  onToggle(enabled: boolean): void
  onReveal(): void
  onRotate(): void
  onTest(): void
  onResend(id: string): void
  onMore(): void
  onRetry(): void
}

function EndpointForm({ initial, busy, onSave }: { initial: string; busy: boolean; onSave(url: string): void }) {
  const [url, setUrl] = useState(initial)
  useEffect(() => setUrl(initial), [initial])
  return (
    <form
      className="flex flex-col gap-2 sm:flex-row sm:items-end"
      onSubmit={(e) => {
        e.preventDefault()
        onSave(url)
      }}
    >
      <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs font-semibold text-muted-foreground">
        HTTPS URL that receives events
        <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://your-server.example.com/datagod-webhook" maxLength={500} className="h-9" />
      </label>
      <Button type="submit" size="sm" className="h-9" disabled={busy || !url.trim()}>Save URL</Button>
    </form>
  )
}

/** Pure view (tested with a static render). Every server-sent string is rendered as React text, never as HTML. */
export function WebhooksView(p: WebhooksViewProps) {
  const ep = p.info?.endpoint ?? null
  return (
    <div className="space-y-4">
      <Panel className="space-y-4">
        <div className="flex items-start gap-3">
          <IconChip icon={Webhook} />
          <div className="min-w-0">
            <Eyebrow>Webhooks</Eyebrow>
            <p className="text-sm text-muted-foreground">
              Datagod POSTs a signed event to your URL when a live order completes, fails or is refunded. Failed deliveries are retried 6 times over about a day and a half.
            </p>
          </div>
        </div>

        {p.error && <InlineError message={p.error} onRetry={p.onRetry} />}
        {p.loading && !p.info && <p className="text-sm text-muted-foreground">Loading…</p>}

        {p.info && !p.info.enabled_globally && (
          <p className="rounded-xl border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
            Webhooks are not switched on yet. Keep polling the order endpoints for now; this page will let you set a URL once they are live.
          </p>
        )}

        {p.info?.enabled_globally && (
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
            <div className="space-y-3">
              <EndpointForm initial={ep?.url ?? ""} busy={p.busy} onSave={p.onSave} />
              {ep && (
                <div className="flex flex-wrap items-center gap-2">
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={ep.enabled} disabled={p.busy} onChange={(e) => p.onToggle(e.target.checked)} className="size-4 accent-primary" />
                    Send events to this URL
                  </label>
                  <Button size="sm" variant="ghost" className="h-8 text-rose-600 dark:text-rose-400" disabled={p.busy} onClick={p.onDelete}>
                    <Trash2 className="mr-1 size-3.5" aria-hidden /> Remove
                  </Button>
                </div>
              )}
            </div>
            {ep && (
              <div className="space-y-3 rounded-xl border border-border p-3">
                <div>
                  <p className="text-xs font-semibold text-muted-foreground">Signing secret</p>
                  <p className="mt-1 break-all font-mono text-xs">{p.shownSecret ?? `whsec_…${ep.secret_hint}`}</p>
                  {p.shownSecret && <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">Copy it now and keep it on your server only.</p>}
                </div>
                <div className="flex flex-wrap gap-2">
                  {p.shownSecret ? (
                    <Button size="sm" variant="outline" className="h-8" onClick={() => void navigator.clipboard?.writeText(p.shownSecret ?? "").then(() => toast.success("Copied"))}>
                      <Copy className="mr-1 size-3.5" aria-hidden /> Copy
                    </Button>
                  ) : (
                    <Button size="sm" variant="outline" className="h-8" disabled={p.busy} onClick={p.onReveal}>
                      <Eye className="mr-1 size-3.5" aria-hidden /> Reveal
                    </Button>
                  )}
                  <Button size="sm" variant="outline" className="h-8" disabled={p.busy} onClick={p.onRotate}>
                    <RefreshCw className="mr-1 size-3.5" aria-hidden /> Rotate
                  </Button>
                  <Button size="sm" className="h-8" disabled={p.busy} onClick={p.onTest}>
                    <Send className="mr-1 size-3.5" aria-hidden /> Send test event
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Check the Datagod-Signature header: t=&lt;time&gt;,v1=HMAC-SHA256 of &quot;t.body&quot; with this secret. Rotating replaces it at once.
                </p>
              </div>
            )}
          </div>
        )}
      </Panel>

      {p.info?.enabled_globally && (
        <Panel className="space-y-3">
          <Eyebrow>Deliveries</Eyebrow>
          {p.deliveries.length === 0 && <p className="text-sm text-muted-foreground">No events yet. Send a test event to see one here.</p>}
          <ul className="divide-y divide-border">
            {p.deliveries.map((d) => (
              <li key={d.id} className="space-y-1 py-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <span className={cn("rounded-full px-2.5 py-0.5 text-xs font-semibold capitalize", TONE_CHIP[STATE_TONE[d.state] ?? "slate"])}>{d.state}</span>
                    <span className="font-mono text-xs">{d.type}</span>
                    {d.payload?.data?.reference && <span className="break-all font-mono text-xs">{d.payload.data.reference}</span>}
                    {d.payload?.data?.status && <span className="text-xs text-muted-foreground">→ {d.payload.data.status}</span>}
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">{shortTime(d.created_at)}</span>
                    {d.state !== "pending" && (
                      <Button size="sm" variant="ghost" className="h-7 px-2" disabled={p.busy} onClick={() => p.onResend(d.id)}>Resend</Button>
                    )}
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  {d.attempts} attempt{d.attempts === 1 ? "" : "s"}
                  {d.last_error ? ` · ${d.last_error}` : d.last_code ? ` · HTTP ${d.last_code}` : ""}
                  {d.state === "pending" && d.next_attempt_at ? ` · next try ${shortTime(d.next_attempt_at)}` : ""}
                </p>
                {d.attempts_log.length > 0 && (
                  <details className="text-xs">
                    <summary className="cursor-pointer text-muted-foreground">Attempts</summary>
                    <ul className="mt-1 space-y-1">
                      {d.attempts_log.map((a) => (
                        <li key={`${a.attempt}-${a.at}`} className="rounded-lg bg-muted/40 p-2">
                          <span className="font-semibold">#{a.attempt}</span> {shortTime(a.at)} · {a.ok ? "OK" : "Failed"}
                          {a.code ? ` · HTTP ${a.code}` : ""}
                          {a.duration_ms != null ? ` · ${a.duration_ms} ms` : ""}
                          {a.error ? ` · ${a.error}` : ""}
                          {a.snippet && <span className="mt-1 block break-all font-mono text-[11px] text-muted-foreground">{a.snippet}</span>}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </li>
            ))}
          </ul>
          {p.next && (
            <div className="flex justify-center">
              <Button size="sm" variant="outline" disabled={p.loading} onClick={p.onMore}>{p.loading ? "Loading…" : "Load more"}</Button>
            </div>
          )}
        </Panel>
      )}
    </div>
  )
}

export function WebhooksTab() {
  const [info, setInfo] = useState<WebhookInfo | null>(null)
  const [deliveries, setDeliveries] = useState<DeliveryRow[]>([])
  const [next, setNext] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [shownSecret, setShownSecret] = useState<string | null>(null)
  const gate = useRef(latestGate())

  const loadDeliveries = useCallback(async (cursor: string | null) => {
    const ticket = gate.current.next()
    setLoading(true)
    const r = await dashJson<{ rows: DeliveryRow[]; next: string | null }>(
      `/api/user/v2-dashboard/webhook/deliveries${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
    )
    if (!gate.current.isLatest(ticket)) return
    setLoading(false)
    if (!r.ok) return setError(r.error)
    setDeliveries((prev) => (cursor ? [...prev, ...r.data.rows] : r.data.rows))
    setNext(r.data.next)
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    const r = await dashJson<WebhookInfo>("/api/user/v2-dashboard/webhook")
    setLoading(false)
    if (!r.ok) return setError(r.error)
    setError(null)
    setInfo(r.data)
    if (r.data.enabled_globally) await loadDeliveries(null)
  }, [loadDeliveries])
  useEffect(() => void load(), [load])

  const act = async <T,>(fn: () => Promise<{ ok: true; data: T } | { ok: false; error: string }>, done: (d: T) => void) => {
    setBusy(true)
    const r = await fn()
    setBusy(false)
    if (!r.ok) return void toast.error(r.error)
    done(r.data)
  }
  type Saved = WebhookInfo & { secret?: string }

  return (
    <WebhooksView
      loading={loading}
      error={error}
      info={info}
      deliveries={deliveries}
      next={next}
      busy={busy}
      shownSecret={shownSecret}
      onRetry={() => void load()}
      onMore={() => void loadDeliveries(next)}
      onSave={(url) =>
        void act(() => dashJson<Saved>("/api/user/v2-dashboard/webhook", { method: "PUT", body: { url } }), (d) => {
          setInfo({ enabled_globally: d.enabled_globally, endpoint: d.endpoint })
          if (d.secret) setShownSecret(d.secret)
          toast.success("Webhook URL saved")
        })
      }
      onToggle={(enabled) => {
        const url = info?.endpoint?.url
        if (!url) return
        void act(() => dashJson<Saved>("/api/user/v2-dashboard/webhook", { method: "PUT", body: { url, enabled } }), (d) =>
          setInfo({ enabled_globally: d.enabled_globally, endpoint: d.endpoint }),
        )
      }}
      onDelete={() => {
        if (!window.confirm("Remove this webhook URL? Queued events will not be sent.")) return
        void act(() => dashJson<{ removed: boolean }>("/api/user/v2-dashboard/webhook", { method: "DELETE" }), () => {
          setShownSecret(null)
          void load()
        })
      }}
      onReveal={() => void act(() => dashJson<{ secret: string }>("/api/user/v2-dashboard/webhook/secret"), (d) => setShownSecret(d.secret))}
      onRotate={() => {
        if (!window.confirm("Rotate the secret? Your server must use the new one straight away.")) return
        void act(() => dashJson<Saved>("/api/user/v2-dashboard/webhook/secret", { method: "POST" }), (d) => {
          if (d.secret) setShownSecret(d.secret)
          toast.success("New secret created")
        })
      }}
      onTest={() =>
        void act(
          () => dashJson<{ ok: boolean; code: number | null; error: string | null }>("/api/user/v2-dashboard/webhook/test", { method: "POST" }),
          (d) => {
            if (d.ok) toast.success(`Test event delivered (HTTP ${d.code})`)
            else toast.error(`Test event failed: ${d.error ?? "no answer"}`)
            void loadDeliveries(null)
          },
        )
      }
      onResend={(id) =>
        void act(() => dashJson<{ ok: boolean }>(`/api/user/v2-dashboard/webhook/deliveries/${id}/resend`, { method: "POST" }), () => {
          toast.success("Queued to send again within a minute")
          void loadDeliveries(null)
        })
      }
    />
  )
}
