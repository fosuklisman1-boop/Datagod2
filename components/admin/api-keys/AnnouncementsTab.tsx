"use client"

import { useCallback, useEffect, useState } from "react"
import { Loader2, Megaphone, Pencil, Plus, Trash2 } from "lucide-react"
import type { AdminAnnouncement } from "@/lib/api-v2/admin-console/announcements"
import type { PublicAnnouncement } from "@/lib/api-v2/announcements"
import { BODY_MAX, SEVERITIES, TITLE_MAX, fromLocalInput, toLocalInput, validateAnnouncement, type AnnouncementDraft } from "@/lib/api-v2/admin-console/console-forms"
import { AnnouncementBannerView } from "@/components/developer/AnnouncementBanner"
import { cn } from "@/lib/utils"
import { adminFetch } from "./admin-fetch"
import { Eyebrow, IconChip, InlineError, Panel } from "./ui"

/** The draft exactly as developers will see it in the banner. */
export function draftToPublic(d: AnnouncementDraft): PublicAnnouncement {
  const severity = (SEVERITIES as readonly string[]).includes(d.severity) ? (d.severity as PublicAnnouncement["severity"]) : "info"
  return { id: "preview", title: d.title.trim() || "Title", body: d.body.trim() || "Text", severity, endsAt: fromLocalInput(d.endsAt) ?? "" }
}

const chars = (s: string) => Array.from(s.trim()).length
const STATE_CHIP = {
  active: { label: "Active", tone: "border-emerald-500/30 bg-emerald-500/[0.06] text-emerald-700 dark:text-emerald-300" },
  scheduled: { label: "Scheduled", tone: "border-primary/30 bg-primary/10 text-primary" },
  ended: { label: "Ended", tone: "border-border bg-muted/50 text-muted-foreground" },
} as const

const inputCls = "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"

export function AnnouncementForm(p: { draft: AnnouncementDraft; busy: boolean; editing: boolean; onChange: (d: AnnouncementDraft) => void; onSubmit: () => void; onCancel: () => void }) {
  const errors = validateAnnouncement(p.draft)
  const set = (k: keyof AnnouncementDraft) => (e: { target: { value: string } }) => p.onChange({ ...p.draft, [k]: e.target.value })
  return (
    <div className="grid gap-4 rounded-xl border border-border bg-muted/30 p-4 lg:grid-cols-2">
      <div className="space-y-3">
        <label className="block space-y-1 text-sm">
          <span className="flex justify-between font-medium text-foreground">
            <span>Title</span>
            <span className={cn("tabular-nums", chars(p.draft.title) > TITLE_MAX ? "text-rose-600" : "text-muted-foreground")}>{chars(p.draft.title)}/{TITLE_MAX}</span>
          </span>
          <input value={p.draft.title} onChange={set("title")} className={inputCls} />
        </label>
        <label className="block space-y-1 text-sm">
          <span className="flex justify-between font-medium text-foreground">
            <span>Text (plain text, no links)</span>
            <span className={cn("tabular-nums", chars(p.draft.body) > BODY_MAX ? "text-rose-600" : "text-muted-foreground")}>{chars(p.draft.body)}/{BODY_MAX}</span>
          </span>
          <textarea value={p.draft.body} onChange={set("body")} rows={4} className={inputCls} />
        </label>
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="block space-y-1 text-sm">
            <span className="font-medium text-foreground">Severity</span>
            <select value={p.draft.severity} onChange={set("severity")} className={inputCls}>
              {SEVERITIES.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </label>
          <label className="block space-y-1 text-sm">
            <span className="font-medium text-foreground">Starts</span>
            <input type="datetime-local" value={p.draft.startsAt} onChange={set("startsAt")} className={inputCls} />
          </label>
          <label className="block space-y-1 text-sm">
            <span className="font-medium text-foreground">Ends</span>
            <input type="datetime-local" value={p.draft.endsAt} onChange={set("endsAt")} className={inputCls} />
          </label>
        </div>
        {errors.length > 0 && (
          <ul className="list-disc space-y-0.5 pl-5 text-sm text-rose-700 dark:text-rose-300">
            {errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={p.busy || errors.length > 0} onClick={p.onSubmit} className="inline-flex h-9 items-center gap-2 rounded-xl bg-primary px-4 text-sm font-semibold text-primary-foreground disabled:opacity-60">
            {p.busy && <Loader2 className="size-4 animate-spin" aria-hidden />}
            {p.editing ? "Save changes" : "Publish"}
          </button>
          <button type="button" disabled={p.busy} onClick={p.onCancel} className="h-9 rounded-xl border border-border px-4 text-sm font-semibold">
            Cancel
          </button>
        </div>
      </div>
      <div className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Preview (exactly what developers see)</p>
        <AnnouncementBannerView items={[draftToPublic(p.draft)]} dismissed={[]} onDismiss={() => {}} />
      </div>
    </div>
  )
}

const when = (iso: string) => new Date(iso).toLocaleString("en-GB", { timeZone: "UTC", dateStyle: "medium", timeStyle: "short" }) + " GMT"

function emptyDraft(): AnnouncementDraft {
  const start = new Date(Date.now() + 5 * 60_000)
  const end = new Date(start.getTime() + 2 * 3600_000)
  return { title: "", body: "", severity: "info", startsAt: toLocalInput(start.toISOString()), endsAt: toLocalInput(end.toISOString()) }
}

export function AnnouncementsTabView(p: {
  items: AdminAnnouncement[]
  loading: boolean
  error: string | null
  notice: { kind: "ok" | "error"; text: string } | null
  busy: boolean
  onSave: (draft: AnnouncementDraft, id: string | null) => Promise<boolean>
  onDelete: (id: string) => Promise<boolean>
  onRetry: () => void
}) {
  const [editing, setEditing] = useState<{ id: string | null; draft: AnnouncementDraft } | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  return (
    <Panel className="space-y-4">
      <div className="flex flex-wrap items-start gap-3">
        <IconChip icon={Megaphone} />
        <div className="min-w-0 flex-1">
          <Eyebrow>API v2</Eyebrow>
          <h2 className="text-base font-bold text-foreground">Announcements</h2>
          <p className="text-sm text-muted-foreground">Shown at the top of the developer docs, the status page and the developer dashboard while active.</p>
        </div>
        {!editing && (
          <button type="button" onClick={() => setEditing({ id: null, draft: emptyDraft() })} className="inline-flex h-9 items-center gap-2 rounded-xl bg-primary px-3.5 text-sm font-semibold text-primary-foreground">
            <Plus className="size-4" aria-hidden />
            New announcement
          </button>
        )}
      </div>
      {p.notice &&
        (p.notice.kind === "error" ? (
          <InlineError message={p.notice.text} />
        ) : (
          <p role="status" className="rounded-xl border border-emerald-500/30 bg-emerald-500/[0.06] px-3 py-2 text-sm text-emerald-700 dark:text-emerald-300">{p.notice.text}</p>
        ))}
      {editing && (
        <AnnouncementForm
          draft={editing.draft}
          busy={p.busy}
          editing={editing.id !== null}
          onChange={(draft) => setEditing({ ...editing, draft })}
          onCancel={() => setEditing(null)}
          onSubmit={async () => {
            if (await p.onSave(editing.draft, editing.id)) setEditing(null)
          }}
        />
      )}
      {p.error ? (
        <InlineError message={p.error} onRetry={p.onRetry} />
      ) : p.loading && p.items.length === 0 ? (
        <div className="h-24 animate-pulse rounded-xl bg-muted" aria-label="Loading announcements" />
      ) : p.items.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">No announcements yet.</p>
      ) : (
        <ul className="divide-y divide-border rounded-xl border border-border">
          {p.items.map((a) => {
            const chip = STATE_CHIP[a.state]
            return (
              <li key={a.id} className="space-y-2 px-3 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={cn("rounded-full border px-2 py-0.5 text-[11px] font-bold", chip.tone)}>{chip.label}</span>
                  <span className="rounded-full border border-border px-2 py-0.5 text-[11px] font-bold uppercase text-muted-foreground">{a.severity}</span>
                  <span className="min-w-0 break-words font-semibold text-foreground">{a.title}</span>
                </div>
                <p className="whitespace-pre-line break-words text-sm text-muted-foreground">{a.body}</p>
                <p className="text-xs text-muted-foreground">{when(a.startsAt)} to {when(a.endsAt)}</p>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => setEditing({ id: a.id, draft: { title: a.title, body: a.body, severity: a.severity, startsAt: toLocalInput(a.startsAt), endsAt: toLocalInput(a.endsAt) } })}
                    className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border px-2.5 text-xs font-semibold"
                  >
                    <Pencil className="size-3.5" aria-hidden />
                    Edit
                  </button>
                  {confirmDelete === a.id ? (
                    <>
                      <button type="button" disabled={p.busy} onClick={async () => { if (await p.onDelete(a.id)) setConfirmDelete(null) }} className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-rose-600 px-2.5 text-xs font-semibold text-white disabled:opacity-60">
                        Confirm delete
                      </button>
                      <button type="button" onClick={() => setConfirmDelete(null)} className="h-8 rounded-lg border border-border px-2.5 text-xs font-semibold">Keep</button>
                    </>
                  ) : (
                    <button type="button" onClick={() => setConfirmDelete(a.id)} className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-rose-500/40 px-2.5 text-xs font-semibold text-rose-600 dark:text-rose-400">
                      <Trash2 className="size-3.5" aria-hidden />
                      Delete
                    </button>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </Panel>
  )
}

export function AnnouncementsTab() {
  const [items, setItems] = useState<AdminAnnouncement[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    const r = await adminFetch<{ announcements?: AdminAnnouncement[] }>("/api/admin/api-v2/announcements")
    setItems(r.ok ? (r.data?.announcements ?? []) : [])
    setError(r.ok ? null : r.error)
    setLoading(false)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const run = async (url: string, init: RequestInit, ok: string) => {
    if (busy) return false
    setBusy(true)
    setNotice(null)
    const r = await adminFetch(url, init)
    setBusy(false)
    if (!r.ok) {
      setNotice({ kind: "error", text: r.error ?? "Could not save." })
      return false
    }
    setNotice({ kind: "ok", text: ok })
    await load()
    return true
  }

  const onSave = (d: AnnouncementDraft, id: string | null) => {
    const body = JSON.stringify({ title: d.title.trim(), body: d.body.trim(), severity: d.severity, startsAt: fromLocalInput(d.startsAt), endsAt: fromLocalInput(d.endsAt) })
    return id
      ? run(`/api/admin/api-v2/announcements/${encodeURIComponent(id)}`, { method: "PUT", body }, "Saved. Developers see the change within a minute.")
      : run("/api/admin/api-v2/announcements", { method: "POST", body }, "Published. Developers see it within a minute of its start time.")
  }
  const onDelete = (id: string) => run(`/api/admin/api-v2/announcements/${encodeURIComponent(id)}`, { method: "DELETE" }, "Deleted.")

  return <AnnouncementsTabView items={items} loading={loading} error={error} notice={notice} busy={busy} onSave={onSave} onDelete={onDelete} onRetry={() => void load()} />
}
