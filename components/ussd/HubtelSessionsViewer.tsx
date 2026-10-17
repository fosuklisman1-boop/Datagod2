"use client"

import { useCallback, useEffect, useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Check, ChevronsUpDown, Loader2, RefreshCw } from "lucide-react"
import { supabase } from "@/lib/supabase"

/** GET with the signed-in user's bearer token (admin and shop-owner endpoints both use it). */
export async function bearerFetch(path: string): Promise<Response> {
  const { data: { session } } = await supabase.auth.getSession()
  return fetch(path, { headers: { Authorization: `Bearer ${session?.access_token ?? ""}` } })
}

/** Hubtel USSD session list + chat-style transcript. Used by the admin page and the shop owner dashboard. */
interface SessionRow {
  session_id: string
  mobile: string | null
  shop_id: string | null
  shop_name?: string | null
  started_at: string
  ended_at: string
  exchanges: number
  amount: number | null
  outcome: string
}
interface TranscriptRow {
  created_at: string
  request_type: string | null
  input: string | null
  reply_type: string | null
  reply: string | null
}
interface ShopOption { id: string; name: string; code: string }

export interface HubtelSessionsViewerProps {
  /** Authenticated GET (adds the bearer token). */
  fetcher: (path: string) => Promise<Response>
  /** e.g. /api/admin/ussd-hubtel/sessions or /api/dashboard/ussd-shop/sessions */
  basePath: string
  /** Admin only: shop column and shop filter. */
  admin?: boolean
  title?: string
  description?: string
}

const ALL = "all"

function outcomeVariant(o: string): "default" | "secondary" | "destructive" | "outline" {
  if (o.startsWith("Paid")) return "default"
  if (o === "Payment failed" || o === "Timed out") return "destructive"
  if (o === "Awaiting payment") return "secondary"
  return "outline"
}

function selectedLabel(shops: ShopOption[], shopId: string): string {
  if (shopId === ALL) return "All sessions"
  const s = shops.find(x => x.id === shopId)
  return s ? `${s.name} (${s.code})` : "Selected shop"
}

const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
const fmtDateTime = (iso: string) => new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })
const localPhone = (m: string | null) => (m ? m.replace(/^\+?233/, "0") : "-")

export function HubtelSessionsViewer({ fetcher, basePath, admin = false, title, description }: HubtelSessionsViewerProps) {
  const [sessions, setSessions] = useState<SessionRow[]>([])
  const [nextBefore, setNextBefore] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [shops, setShops] = useState<ShopOption[]>([])
  const [shopId, setShopId] = useState<string>(ALL)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [open, setOpen] = useState<SessionRow | null>(null)
  const [transcript, setTranscript] = useState<TranscriptRow[] | null>(null)
  const [transcriptError, setTranscriptError] = useState<string | null>(null)

  const load = useCallback(async (before: string | null) => {
    setLoading(true)
    setError(null)
    try {
      const q = new URLSearchParams({ limit: "30" })
      if (before) q.set("before", before)
      if (admin && shopId !== ALL) q.set("shopId", shopId)
      if (admin && !before && shops.length === 0) q.set("includeShops", "1")
      const res = await fetcher(`${basePath}?${q}`)
      const json = await res.json().catch(() => ({}))
      if (!res.ok) { setError(json.error ?? "Failed to load sessions"); return }
      setSessions(prev => (before ? [...prev, ...json.sessions] : json.sessions))
      setNextBefore(json.nextBefore ?? null)
      if (json.shops) setShops(json.shops)
    } catch {
      setError("Failed to load sessions")
    } finally {
      setLoading(false)
    }
    // shops.length only decides whether to ask for the shop list once
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher, basePath, admin, shopId])

  useEffect(() => { load(null) }, [load])

  const openSession = async (s: SessionRow) => {
    setOpen(s)
    setTranscript(null)
    setTranscriptError(null)
    try {
      const res = await fetcher(`${basePath}/${encodeURIComponent(s.session_id)}`)
      const json = await res.json().catch(() => ({}))
      if (!res.ok) { setTranscriptError(json.error ?? "Failed to load transcript"); return }
      setTranscript(json.rows)
    } catch {
      setTranscriptError("Failed to load transcript")
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <CardTitle className="text-base">{title ?? "USSD sessions"}</CardTitle>
          <CardDescription>{description ?? "Every Hubtel USSD session, screen by screen. Kept for 30 days."}</CardDescription>
        </div>
        <div className="flex items-center gap-2">
          {admin && (
            <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
              <PopoverTrigger asChild>
                <Button variant="outline" size="sm" role="combobox" aria-expanded={pickerOpen} aria-label="Filter by shop" className="w-56 justify-between font-normal">
                  <span className="truncate">{selectedLabel(shops, shopId)}</span>
                  <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-72 p-0" align="end">
                <Command>
                  <CommandInput placeholder="Search shop name or code..." />
                  {/* Scrolls on its own (wheel + touch): onWheel stops the page from swallowing the scroll. */}
                  <CommandList className="max-h-72 overflow-y-auto" onWheel={e => e.stopPropagation()}>
                    <CommandEmpty>No shop found.</CommandEmpty>
                    <CommandGroup>
                      <CommandItem value="all sessions" onSelect={() => { setShopId(ALL); setPickerOpen(false) }}>
                        <Check className={`mr-2 h-4 w-4 ${shopId === ALL ? "opacity-100" : "opacity-0"}`} />
                        All sessions
                      </CommandItem>
                      {shops.map(s => (
                        <CommandItem key={s.id} value={`${s.name} ${s.code} ${s.id}`} onSelect={() => { setShopId(s.id); setPickerOpen(false) }}>
                          <Check className={`mr-2 h-4 w-4 ${shopId === s.id ? "opacity-100" : "opacity-0"}`} />
                          <span className="truncate">{s.name}</span>
                          <span className="ml-auto pl-2 text-xs text-muted-foreground font-mono">{s.code}</span>
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
          )}
          <Button variant="outline" size="sm" onClick={() => load(null)} aria-label="Refresh" disabled={loading}>
            <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {error && <p className="text-sm text-destructive mb-3">{error}</p>}
        {!error && !loading && sessions.length === 0 && (
          <p className="text-sm text-muted-foreground">No USSD sessions yet.</p>
        )}
        {sessions.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-muted-foreground border-b">
                  <th className="py-2 pr-3 font-medium">Started</th>
                  <th className="py-2 pr-3 font-medium">Caller</th>
                  {admin && <th className="py-2 pr-3 font-medium">Shop</th>}
                  <th className="py-2 pr-3 font-medium">Screens</th>
                  <th className="py-2 pr-3 font-medium">Amount</th>
                  <th className="py-2 pr-3 font-medium">Outcome</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody>
                {sessions.map(s => (
                  <tr key={s.session_id} className="border-b last:border-0">
                    <td className="py-2 pr-3 whitespace-nowrap">{fmtDateTime(s.started_at)}</td>
                    <td className="py-2 pr-3 font-mono">{localPhone(s.mobile)}</td>
                    {admin && <td className="py-2 pr-3">{s.shop_name ?? <span className="text-muted-foreground">Main menu</span>}</td>}
                    <td className="py-2 pr-3">{s.exchanges}</td>
                    <td className="py-2 pr-3">{s.amount != null ? `GHS ${s.amount.toFixed(2)}` : "-"}</td>
                    <td className="py-2 pr-3"><Badge variant={outcomeVariant(s.outcome)}>{s.outcome}</Badge></td>
                    <td className="py-2 text-right"><Button size="sm" variant="ghost" onClick={() => openSession(s)}>View</Button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {nextBefore && (
          <div className="mt-3 text-center">
            <Button variant="outline" size="sm" onClick={() => load(nextBefore)} disabled={loading}>
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : "Load more"}
            </Button>
          </div>
        )}
      </CardContent>

      <Dialog open={!!open} onOpenChange={o => { if (!o) setOpen(null) }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="font-mono">{open ? localPhone(open.mobile) : ""}</DialogTitle>
            <DialogDescription>
              {open && <>{fmtDateTime(open.started_at)}{admin && open.shop_name ? ` · ${open.shop_name}` : ""} · {open.outcome}</>}
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[65vh] overflow-y-auto space-y-3 pr-1">
            {transcriptError && <p className="text-sm text-destructive">{transcriptError}</p>}
            {!transcript && !transcriptError && <div className="flex justify-center py-6"><Loader2 className="w-5 h-5 animate-spin" /></div>}
            {transcript?.map((r, i) => (
              <div key={i} className="space-y-2">
                {r.request_type === "Timeout" ? (
                  <p className="text-center text-xs text-muted-foreground">{fmtTime(r.created_at)} · Session timed out</p>
                ) : (
                  <div className="flex justify-start">
                    <div className="max-w-[80%] rounded-2xl rounded-bl-sm bg-muted px-3 py-2">
                      <p className="text-[10px] text-muted-foreground">{fmtTime(r.created_at)}{r.request_type === "Initiation" ? " · dialled" : ""}</p>
                      <p className="text-sm whitespace-pre-wrap break-words">{r.input || "(empty)"}</p>
                    </div>
                  </div>
                )}
                {r.reply && r.request_type !== "Timeout" && (
                  <div className="flex justify-end">
                    <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-[#1b388b] text-white px-3 py-2">
                      <p className="text-sm whitespace-pre-wrap break-words">{r.reply}</p>
                      {r.reply_type === "AddToCart" && <p className="mt-1 text-[10px] opacity-80">Payment prompt sent</p>}
                      {r.reply_type === "release" && <p className="mt-1 text-[10px] opacity-80">Session ended</p>}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
