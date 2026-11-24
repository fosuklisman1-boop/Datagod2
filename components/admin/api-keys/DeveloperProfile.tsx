"use client"

import { useCallback, useEffect, useState } from "react"
import { ArrowLeft, Loader2, PauseCircle, PlayCircle, UserRound } from "lucide-react"
import type { DeveloperProfile } from "@/lib/api-v2/admin-console/developers"
import { developerBadges, ghs, pauseCopy, pauseErrorText, pauseReasonOk, pct } from "@/lib/api-v2/admin-console/developers-view"
import { formatGhanaDate } from "@/lib/api-v1/retirement-ui"
import { cn } from "@/lib/utils"
import { adminFetch } from "./admin-fetch"
import { Eyebrow, IconChip, InlineError, Panel } from "./ui"
import { TrendBarsView } from "./TrendBars"

const when = (iso: string | null) => {
  if (!iso) return "never"
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : formatGhanaDate(d)
}

const BADGE_TONE = {
  red: "border-rose-500/40 bg-rose-500/10 text-rose-700 dark:text-rose-300",
  primary: "border-primary/30 bg-primary/10 text-primary",
  amber: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
} as const

export function Badges({ paused, granted }: { paused: boolean; granted: boolean }) {
  return (
    <>
      {developerBadges({ paused, granted }).map((b) => (
        <span key={b.label} className={cn("inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-bold", BADGE_TONE[b.tone])}>
          {b.label}
        </span>
      ))}
    </>
  )
}

/** The confirm step for pause / unpause. Pausing needs a 3-200 character internal reason. */
export function PauseForm(p: { paused: boolean; reason: string; busy: boolean; onReason: (v: string) => void; onSubmit: () => void; onCancel: () => void }) {
  const copy = pauseCopy(p.paused)
  const canSubmit = !p.busy && (!copy.needsReason || pauseReasonOk(p.reason))
  return (
    <div className="space-y-3 rounded-xl border border-border bg-muted/40 p-4">
      <p className="text-sm font-semibold text-foreground">{copy.title}</p>
      <p className="text-sm text-muted-foreground">{copy.body}</p>
      {copy.needsReason && (
        <label className="block space-y-1 text-sm">
          <span className="font-medium text-foreground">Internal reason (3-200 characters, only admins see it)</span>
          <textarea
            value={p.reason}
            onChange={(e) => p.onReason(e.target.value)}
            maxLength={200}
            rows={2}
            className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
          />
        </label>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={!canSubmit}
          onClick={p.onSubmit}
          className={cn(
            "inline-flex h-9 items-center gap-2 rounded-xl px-4 text-sm font-semibold text-white disabled:opacity-60",
            p.paused ? "bg-rose-600 hover:bg-rose-700" : "bg-primary hover:bg-primary/90",
          )}
        >
          {p.busy && <Loader2 className="size-4 animate-spin" aria-hidden />}
          {copy.confirm}
        </button>
        <button type="button" disabled={p.busy} onClick={p.onCancel} className="h-9 rounded-xl border border-border px-4 text-sm font-semibold">
          Cancel
        </button>
      </div>
    </div>
  )
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-lg font-bold tabular-nums text-foreground">{value}</p>
    </div>
  )
}

export interface ProfileNotice {
  kind: "ok" | "error"
  text: string
}

export function DeveloperProfileView(p: {
  profile: DeveloperProfile | null
  loading: boolean
  error: string | null
  notice: ProfileNotice | null
  busy: boolean
  onPause: (paused: boolean, reason: string) => Promise<boolean>
  onBack: () => void
  onRetry: () => void
}) {
  const [confirming, setConfirming] = useState<null | boolean>(null)
  const [reason, setReason] = useState("")
  const d = p.profile
  const paused = !!d?.pause

  return (
    <Panel className="space-y-5">
      <button type="button" onClick={p.onBack} className="inline-flex items-center gap-1 text-sm font-semibold text-primary lg:hidden">
        <ArrowLeft className="size-4" aria-hidden />
        Back
      </button>
      {p.error ? (
        <InlineError message={p.error} onRetry={p.onRetry} />
      ) : !d ? (
        <div className="h-40 animate-pulse rounded-xl bg-muted" aria-label="Loading the developer" />
      ) : (
        <>
          <div className="flex flex-wrap items-start gap-3">
            <IconChip icon={UserRound} tone={paused ? "red" : "primary"} />
            <div className="min-w-0 flex-1">
              <Eyebrow>Developer</Eyebrow>
              <h2 className="break-words text-lg font-bold text-foreground">{d.user.name ?? "Unnamed developer"}</h2>
              <p className="break-all text-sm text-muted-foreground">{d.user.email ?? "No email"} · {d.user.role ?? "no role"}</p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                <Badges paused={paused} granted={!!d.grant} />
                {d.user.suspended && <span className="rounded-full border border-rose-500/40 px-2 py-0.5 text-[11px] font-bold text-rose-700">Account suspended</span>}
              </div>
            </div>
            {confirming === null && (
              <button
                type="button"
                onClick={() => {
                  setReason("")
                  setConfirming(!paused)
                }}
                className={cn(
                  "inline-flex h-9 items-center gap-2 rounded-xl border px-3.5 text-sm font-semibold",
                  paused ? "border-primary/40 text-primary" : "border-rose-500/50 text-rose-600 dark:text-rose-400",
                )}
              >
                {paused ? <PlayCircle className="size-4" aria-hidden /> : <PauseCircle className="size-4" aria-hidden />}
                {paused ? "Unpause access" : "Pause access"}
              </button>
            )}
          </div>

          {paused && d.pause && (
            <div className="rounded-xl border border-rose-500/30 bg-rose-500/[0.06] p-3 text-sm">
              <p className="font-semibold text-rose-700 dark:text-rose-300">PAUSED since {when(d.pause.pausedAt)}</p>
              <p className="text-muted-foreground">Why: <span className="text-foreground">{d.pause.reason ?? "no reason recorded"}</span></p>
              <p className="text-muted-foreground">By admin {d.pause.pausedBy ? d.pause.pausedBy.slice(0, 8) : "unknown"}</p>
            </div>
          )}

          {p.notice && (
            p.notice.kind === "error" ? (
              <InlineError message={p.notice.text} />
            ) : (
              <p role="status" className="rounded-xl border border-emerald-500/30 bg-emerald-500/[0.06] px-3 py-2 text-sm text-emerald-700 dark:text-emerald-300">{p.notice.text}</p>
            )
          )}

          {confirming !== null && (
            <PauseForm
              paused={confirming}
              reason={reason}
              busy={p.busy}
              onReason={setReason}
              onCancel={() => setConfirming(null)}
              onSubmit={async () => {
                const ok = await p.onPause(confirming, reason.trim())
                if (ok) setConfirming(null)
              }}
            />
          )}

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Tile label="Calls (30 days)" value={d.totals.requests.toLocaleString("en-GH")} />
            <Tile label="Success rate" value={pct(d.totals.successRate)} />
            <Tile label="Spend" value={ghs(d.totals.spent)} />
            <Tile label="Orders" value={d.totals.orders.toLocaleString("en-GH")} />
          </div>

          <TrendBarsView points={d.daily} loading={false} error={null} onRetry={p.onRetry} />

          <section className="space-y-2">
            <h3 className="text-sm font-bold text-foreground">Keys</h3>
            {d.keys.length === 0 ? (
              <p className="text-sm text-muted-foreground">No keys.</p>
            ) : (
              <ul className="divide-y divide-border rounded-xl border border-border">
                {d.keys.map((k) => {
                  const calls = k.activity && typeof (k.activity as { requests?: unknown }).requests === "number" ? (k.activity as { requests: number }).requests : null
                  return (
                    <li key={k.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                      <span className="min-w-0">
                        <span className="font-mono text-foreground">{k.keyPrefix ?? "key"}</span>
                        <span className="text-muted-foreground"> · {k.keyType ?? "?"} · {k.environment ?? "?"} · {k.status ?? "?"}</span>
                      </span>
                      <span className="text-xs text-muted-foreground">{calls === null ? "no activity data" : `${calls.toLocaleString("en-GH")} calls (30 days)`} · last used {when(k.lastUsedAt)}</span>
                    </li>
                  )
                })}
              </ul>
            )}
          </section>

          <section className="space-y-2">
            <h3 className="text-sm font-bold text-foreground">Recent orders</h3>
            {d.orders.length === 0 ? (
              <p className="text-sm text-muted-foreground">No orders yet.</p>
            ) : (
              <div className="overflow-x-auto rounded-xl border border-border">
                <table className="w-full min-w-[520px] text-left text-sm">
                  <thead className="bg-muted/50 text-xs text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 font-semibold">Reference</th>
                      <th className="px-3 py-2 font-semibold">Network</th>
                      <th className="px-3 py-2 font-semibold">Size</th>
                      <th className="px-3 py-2 font-semibold">Price</th>
                      <th className="px-3 py-2 font-semibold">Recipient</th>
                      <th className="px-3 py-2 font-semibold">Status</th>
                      <th className="px-3 py-2 font-semibold">Time</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {d.orders.map((o, i) => (
                      <tr key={`${o.reference}-${i}`}>
                        <td className="px-3 py-2 font-mono">{o.reference ?? "-"}</td>
                        <td className="px-3 py-2">{o.network ?? "-"}</td>
                        <td className="px-3 py-2">{o.volumeGb === null ? "-" : `${o.volumeGb} GB`}</td>
                        <td className="px-3 py-2 tabular-nums">{ghs(o.price)}</td>
                        <td className="px-3 py-2 font-mono">{o.recipientPhone ?? "-"}</td>
                        <td className="px-3 py-2">{o.status ?? "-"}</td>
                        <td className="px-3 py-2 text-muted-foreground">{when(o.createdAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {d.audit.length > 0 && (
            <section className="space-y-2">
              <h3 className="text-sm font-bold text-foreground">Recent admin actions</h3>
              <ul className="space-y-1 text-sm text-muted-foreground">
                {d.audit.map((a, i) => (
                  <li key={i}>
                    {when(a.createdAt)}: {a.action ?? "action"}
                    {a.reason ? ` (${a.reason})` : ""}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </Panel>
  )
}

/** Loads one developer's profile and runs pause / unpause. */
export function DeveloperProfilePanel({ userId, onBack, onChanged }: { userId: string; onBack: () => void; onChanged: () => void }) {
  const [profile, setProfile] = useState<DeveloperProfile | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<ProfileNotice | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    const r = await adminFetch<{ profile?: DeveloperProfile }>(`/api/admin/api-v2/developers/${encodeURIComponent(userId)}`)
    setProfile(r.ok ? (r.data?.profile ?? null) : null)
    setError(r.ok ? null : r.error)
    setLoading(false)
  }, [userId])

  useEffect(() => {
    setNotice(null)
    void load()
  }, [load])

  const onPause = async (paused: boolean, reason: string) => {
    if (busy) return false
    setBusy(true)
    setNotice(null)
    const r = await adminFetch<{ changed?: boolean }>(`/api/admin/api-v2/developers/${encodeURIComponent(userId)}/pause`, {
      method: "POST",
      body: JSON.stringify({ paused, reason }),
    })
    setBusy(false)
    if (!r.ok) {
      setNotice({ kind: "error", text: pauseErrorText(r.status, r.error) })
      return false
    }
    setNotice({ kind: "ok", text: paused ? "Paused. Every key for this person is blocked within a few seconds." : "Unpaused. Their keys work again within a few seconds." })
    await load()
    onChanged()
    return true
  }

  return <DeveloperProfileView profile={profile} loading={loading} error={error} notice={notice} busy={busy} onPause={onPause} onBack={onBack} onRetry={() => void load()} />
}
