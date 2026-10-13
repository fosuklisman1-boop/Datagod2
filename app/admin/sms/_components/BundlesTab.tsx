"use client"
import { useState } from "react"
import { Loader2, Plus } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { apiRaw, type BundleRow } from "../_lib/api"
import { useLoad } from "../_lib/useLoad"
import { formatCount, formatGhs, formatPerSms, parseBundleDraft } from "../_lib/view"
import { ConfirmDialog, EmptyState, ErrorBox, LoadingRows, StatusBadge } from "./ui-bits"

const URL = "/api/admin/sms/bundles"
const SCOPES = ["all", "shop", "sub_agent", "individual", "platform"]
interface Draft { id?: string; name: string; units: string; price: string; sort: string; mode: "platform" | "business"; scope: string }
const blank = (mode: "platform" | "business"): Draft => ({ name: "", units: "", price: "", sort: "0", mode, scope: "all" })

export default function BundlesTab() {
  const { data, error, loading, reload } = useLoad<BundleRow[]>(async () => {
    const r = await apiRaw<{ bundles?: BundleRow[]; error?: string }>(URL)
    return r.ok && r.body?.bundles ? { success: true, data: r.body.bundles } : { success: false, error: r.body?.error ?? "Could not load bundles" }
  }, [])
  const [draft, setDraft] = useState<Draft | null>(null)
  const [del, setDel] = useState<BundleRow | null>(null)
  const [delError, setDelError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  /** Runs one request; resolves to the server's error text (null on success). Busy always resets. */
  async function call(path: string, init: RequestInit, ok: string): Promise<{ ok: boolean; status: number; error: string | null }> {
    if (busy) return { ok: false, status: 0, error: "Another change is in progress" }
    setBusy(true)
    try {
      const r = await apiRaw<{ error?: string }>(path, init)
      if (r.ok) { toast.success(ok); void reload(); return { ok: true, status: r.status, error: null } }
      return { ok: false, status: r.status, error: r.body?.error ?? (r.status === 0 ? "Network error — try again" : "Something went wrong") }
    } finally { setBusy(false) }
  }

  async function save() {
    if (!draft) return
    const parsed = parseBundleDraft(draft)
    if (!parsed.ok) return void toast.error(parsed.error)
    const { name, units, price, sort } = parsed.value
    const body = { name, units, price_ghs: price, sort_order: sort, mode: draft.mode, owner_type_scope: draft.scope }
    const r = draft.id
      ? await call(URL, { method: "PATCH", body: JSON.stringify({ id: draft.id, ...body }) }, "Bundle updated")
      : await call(URL, { method: "POST", body: JSON.stringify(body) }, "Bundle created")
    if (r.ok) setDraft(null)
    else toast.error(r.error ?? "Something went wrong")
  }

  async function toggle(b: BundleRow) {
    const r = await call(URL, { method: "PATCH", body: JSON.stringify({ id: b.id, active: !b.active }) }, b.active ? "Bundle deactivated" : "Bundle activated")
    if (!r.ok) toast.error(r.error ?? "Something went wrong")
  }

  async function remove() {
    if (!del) return
    const r = await call(`${URL}?id=${encodeURIComponent(del.id)}`, { method: "DELETE" }, "Bundle deleted")
    if (r.ok) { setDel(null); setDelError(null); return }
    // Show the server's refusal (e.g. the 48-hour rule) verbatim; a vanished bundle just closes.
    if (r.status === 404) { toast.error(r.error ?? "Bundle not found"); setDel(null); setDelError(null); void reload() }
    else setDelError(r.error)
  }

  if (loading && !data) return <LoadingRows />
  if (error && !data) return <ErrorBox message={error} onRetry={reload} />
  const stale = loading && !!data
  const groups: { mode: "platform" | "business"; title: string }[] = [{ mode: "platform", title: "Platform" }, { mode: "business", title: "Business" }]

  return (
    <div className="min-w-0 space-y-6">
      {error && <ErrorBox message={error} onRetry={reload} />}
      <div className="flex justify-end"><Button disabled={stale} onClick={() => setDraft(blank("platform"))}><Plus className="size-4" />New bundle</Button></div>
      <div className={`min-w-0 space-y-6 transition-opacity ${stale ? "pointer-events-none opacity-60" : ""}`} aria-busy={loading}>
        {groups.map(({ mode, title }) => {
          const rows = (data ?? []).filter((b) => b.mode === mode)
          return (
            <section key={mode} className="min-w-0 space-y-2">
              <h3 className="text-sm font-semibold">{title} ({rows.length})</h3>
              {rows.length === 0 ? <EmptyState title={`No ${title.toLowerCase()} bundles`} /> : (
                <div className="grid gap-3 lg:grid-cols-2">
                  {rows.map((b) => (
                    <Card key={b.id} className="clay min-w-0 border-0 py-0"><CardContent className="space-y-2 p-4">
                      <div className="flex flex-wrap items-center gap-2">
                        <h4 className="min-w-0 break-words font-semibold">{b.name}</h4>
                        <StatusBadge status={b.active ? "active" : "inactive"} label={b.active ? "Active" : "Inactive"} />
                        {b.owner_type_scope !== "all" && <Badge variant="secondary">{b.owner_type_scope}</Badge>}
                      </div>
                      <p className="break-words text-sm text-muted-foreground">
                        {formatCount(b.units)} credits · {formatGhs(b.price_ghs)} · {formatPerSms(b.price_ghs, b.units)}/SMS · sort {b.sort_order}
                      </p>
                      <div className="flex flex-wrap gap-2">
                        <Button size="sm" variant="outline" disabled={busy} onClick={() => setDraft({ id: b.id, name: b.name, units: String(b.units), price: String(b.price_ghs), sort: String(b.sort_order), mode: b.mode, scope: b.owner_type_scope })}>Edit</Button>
                        <Button size="sm" variant="outline" disabled={busy} onClick={() => void toggle(b)}>{b.active ? "Deactivate" : "Activate"}</Button>
                        {!b.active && <Button size="sm" variant="destructive" disabled={busy} onClick={() => { setDelError(null); setDel(b) }}>Delete</Button>}
                      </div>
                    </CardContent></Card>
                  ))}
                </div>
              )}
            </section>
          )
        })}
      </div>

      <Dialog open={!!draft} onOpenChange={(o) => !o && !busy && setDraft(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>{draft?.id ? "Edit bundle" : "New bundle"}</DialogTitle><DialogDescription>Customers only see bundles for their own mode.</DialogDescription></DialogHeader>
          {draft && (
            <div className="grid gap-3">
              <Input placeholder="Name, e.g. Starter - 1,000 SMS" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
              <div className="grid grid-cols-2 gap-3">
                <Input inputMode="numeric" placeholder="Credits" value={draft.units} onChange={(e) => setDraft({ ...draft, units: e.target.value })} />
                <Input inputMode="decimal" placeholder="Price (GH₵)" value={draft.price} onChange={(e) => setDraft({ ...draft, price: e.target.value })} />
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <Input inputMode="numeric" placeholder="Sort" value={draft.sort} onChange={(e) => setDraft({ ...draft, sort: e.target.value })} />
                <Select value={draft.mode} onValueChange={(v) => setDraft({ ...draft, mode: v as "platform" | "business" })}>
                  <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="platform">Platform</SelectItem><SelectItem value="business">Business</SelectItem></SelectContent>
                </Select>
                <Select value={draft.scope} onValueChange={(v) => setDraft({ ...draft, scope: v })}>
                  <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>{SCOPES.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              {Number(draft.units) > 0 && Number(draft.price) >= 0 && draft.price !== "" && <p className="text-xs text-muted-foreground">≈ {formatPerSms(draft.price, draft.units)} per SMS</p>}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setDraft(null)}>Cancel</Button>
            <Button disabled={busy} onClick={() => void save()}>{busy && <Loader2 className="size-4 animate-spin" />}Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog open={!!del} onOpenChange={(o) => { if (!o) { setDel(null); setDelError(null) } }} busy={busy} destructive
        title={`Delete ${del?.name ?? "bundle"}?`} confirmLabel="Delete"
        description="Only possible 48 hours after a bundle was deactivated, so payments already in progress can still be credited. Past purchases are not affected."
        onConfirm={remove}>
        {delError && <div role="alert" className="break-words rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300">{delError}</div>}
      </ConfirmDialog>
    </div>
  )
}
