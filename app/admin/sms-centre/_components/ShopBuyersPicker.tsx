"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { api } from "../_lib/api"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { toast } from "sonner"
import { Loader2, Search, ShieldOff, ChevronDown, X } from "lucide-react"

export interface ShopRow {
  id: string
  name: string
  subdomain: string
  link: string
  buyers: number
}

export type SinceChoice = "all" | "30" | "90" | "180"

/** What the Broadcast tab needs to send and estimate. */
export interface ShopBuyersSelection {
  shopIds: string[] | "all"
  sinceDays: number | undefined
  total: number
  shopCount: number
  /** Biggest selected shop: used for the preview. */
  sampleShop: ShopRow | null
  /** Longest selected name/link: used for the worst-case SMS length. */
  longestName: string
  longestLink: string
}

interface CountsData {
  shops: ShopRow[]
  total: number
  optedOut: number
}
interface OptOutItem {
  phone: string
  reason: string | null
  created_at: string
}

const fmt = (n: number) => n.toLocaleString("en-US")

export default function ShopBuyersPicker({ onChange }: { onChange: (s: ShopBuyersSelection) => void }) {
  const [since, setSince] = useState<SinceChoice>("all")
  const [data, setData] = useState<CountsData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState("")
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const load = useCallback(async (s: SinceChoice) => {
    setLoading(true)
    setError(null)
    const res = await api<CountsData>(`/api/admin/broadcast/shop-buyers?since=${s}`)
    if (res.success && res.data) setData(res.data)
    else setError(res.error ?? "Failed to load shop buyers")
    setLoading(false)
  }, [])

  useEffect(() => { void load(since) }, [since, load])

  // Drop selections for shops that no longer have buyers in this window.
  useEffect(() => {
    if (!data) return
    const ids = new Set(data.shops.map((s) => s.id))
    setSelected((cur) => new Set([...cur].filter((id) => ids.has(id))))
  }, [data])

  const shops = useMemo(() => data?.shops ?? [], [data])
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase()
    return q ? shops.filter((s) => s.name.toLowerCase().includes(q) || s.subdomain.toLowerCase().includes(q)) : shops
  }, [shops, search])

  const chosen = useMemo(() => shops.filter((s) => selected.has(s.id)), [shops, selected])
  const total = chosen.reduce((n, s) => n + s.buyers, 0)
  const allSelected = shops.length > 0 && chosen.length === shops.length
  const allVisibleSelected = visible.length > 0 && visible.every((s) => selected.has(s.id))

  useEffect(() => {
    const longest = (pick: (s: ShopRow) => string) => chosen.reduce((m, s) => (pick(s).length > m.length ? pick(s) : m), "")
    onChange({
      shopIds: allSelected ? "all" : chosen.map((s) => s.id),
      sinceDays: since === "all" ? undefined : Number(since),
      total,
      shopCount: chosen.length,
      sampleShop: chosen[0] ?? null, // shops come sorted biggest first
      longestName: longest((s) => s.name),
      longestLink: longest((s) => s.link),
    })
  }, [chosen, allSelected, since, total, onChange])

  const toggle = (id: string) =>
    setSelected((cur) => {
      const next = new Set(cur)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const setVisible = (on: boolean) =>
    setSelected((cur) => {
      const next = new Set(cur)
      for (const s of visible) {
        if (on) next.add(s.id)
        else next.delete(s.id)
      }
      return next
    })

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Everyone who paid for, or received, data through a shop. Each number gets one SMS, with the subdomain link of the
        shop it bought from most recently.
      </p>

      <div className="flex flex-wrap gap-2">
        <div className="relative min-w-[12rem] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-9" placeholder="Search shops…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search shops" />
        </div>
        <Select value={since} onValueChange={(v) => setSince(v as SinceChoice)}>
          <SelectTrigger className="w-40 bg-card" aria-label="Bought within">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Bought any time</SelectItem>
            <SelectItem value="30">Last 30 days</SelectItem>
            <SelectItem value="90">Last 90 days</SelectItem>
            <SelectItem value="180">Last 180 days</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {error ? (
        <p className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">{error}</p>
      ) : (
        <div className="overflow-hidden rounded-lg border">
          <div className="flex items-center justify-between gap-2 border-b bg-muted/40 px-3 py-2 text-xs">
            <label className="flex cursor-pointer items-center gap-2 font-medium">
              <Checkbox checked={allVisibleSelected} onCheckedChange={(v) => setVisible(Boolean(v))} disabled={loading || visible.length === 0} aria-label="Select all shops shown" />
              {search ? `Select all ${visible.length} shown` : "Select all"}
            </label>
            <span className="text-muted-foreground">
              {loading ? "Loading…" : `${fmt(shops.length)} shops · ${fmt(data?.total ?? 0)} buyers`}
            </span>
          </div>
          <div className="max-h-72 overflow-y-auto">
            {loading && !data ? (
              <div className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
            ) : visible.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">{search ? "No shops match your search." : "No shop buyers in this period."}</p>
            ) : (
              <ul className="divide-y">
                {visible.map((s) => (
                  <li key={s.id}>
                    <label className={`flex cursor-pointer items-center gap-3 px-3 py-2 text-sm hover:bg-accent ${selected.has(s.id) ? "bg-primary/5" : ""}`}>
                      <Checkbox checked={selected.has(s.id)} onCheckedChange={() => toggle(s.id)} aria-label={`Select ${s.name}`} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">{s.name}</span>
                        <span className="block truncate text-xs text-muted-foreground">{s.link.replace(/^https:\/\//, "")}</span>
                      </span>
                      <span className="shrink-0 tabular-nums font-semibold">{fmt(s.buyers)}</span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 border-t bg-muted/40 px-3 py-2 text-sm">
            <span>
              <span className="font-bold">{fmt(total)}</span> buyer{total === 1 ? "" : "s"} in {fmt(chosen.length)} shop{chosen.length === 1 ? "" : "s"}
            </span>
            <span className="text-xs text-muted-foreground">{fmt(data?.optedOut ?? 0)} opted out (never sent)</span>
          </div>
        </div>
      )}

      <OptOutPanel onChanged={() => void load(since)} />
    </div>
  )
}

function OptOutPanel({ onChanged }: { onChanged: () => void }) {
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<OptOutItem[]>([])
  const [total, setTotal] = useState(0)
  const [paste, setPaste] = useState("")
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const res = await api<{ total: number; items: OptOutItem[] }>("/api/admin/sms-opt-outs")
    if (res.success && res.data) {
      setItems(res.data.items)
      setTotal(res.data.total)
    }
  }, [])
  useEffect(() => { if (open) void load() }, [open, load])

  const add = async () => {
    setBusy(true)
    const res = await api<{ added: number; invalid: string[] }>("/api/admin/sms-opt-outs", {
      method: "POST",
      body: JSON.stringify({ phones: paste }),
    })
    setBusy(false)
    if (!res.success || !res.data) return toast.error(res.error ?? "Failed to add")
    toast.success(`Added ${res.data.added} number${res.data.added === 1 ? "" : "s"}${res.data.invalid.length ? ` · ${res.data.invalid.length} invalid skipped` : ""}`)
    setPaste("")
    await load()
    onChanged()
  }
  const remove = async (phone: string) => {
    const res = await api("/api/admin/sms-opt-outs", { method: "DELETE", body: JSON.stringify({ phones: [phone] }) })
    if (!res.success) return toast.error(res.error ?? "Failed to remove")
    await load()
    onChanged()
  }

  return (
    <div className="rounded-lg border">
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full items-center justify-between gap-2 px-3 py-2 text-sm font-medium" aria-expanded={open}>
        <span className="flex items-center gap-2"><ShieldOff className="h-4 w-4" /> Opt-out list{open ? ` (${fmt(total)})` : ""}</span>
        <ChevronDown className={`h-4 w-4 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div className="space-y-2 border-t p-3">
          <p className="text-xs text-muted-foreground">Numbers here never get shop-buyer broadcasts. Paste one per line or separated by commas.</p>
          <Textarea rows={3} value={paste} onChange={(e) => setPaste(e.target.value)} placeholder={"0241234567\n0201112222"} aria-label="Numbers to opt out" />
          <Button size="sm" onClick={() => void add()} disabled={busy || !paste.trim()}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" />} Add to opt-out list
          </Button>
          {items.length > 0 && (
            <ul className="max-h-40 divide-y overflow-y-auto rounded-md border text-sm">
              {items.map((i) => (
                <li key={i.phone} className="flex items-center justify-between gap-2 px-3 py-1.5">
                  <span className="tabular-nums">{i.phone}</span>
                  <button type="button" onClick={() => void remove(i.phone)} className="text-muted-foreground hover:text-destructive" aria-label={`Remove ${i.phone}`}>
                    <X className="h-4 w-4" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          {total > items.length && <p className="text-xs text-muted-foreground">Showing the latest {items.length} of {fmt(total)}.</p>}
        </div>
      )}
    </div>
  )
}
