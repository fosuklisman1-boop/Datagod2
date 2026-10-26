"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"
import { Gift, Loader2, Pencil, RefreshCw, Trash2, UserX, X } from "lucide-react"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { PageHeaderBanner } from "@/components/shared/page-header-banner"
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { cn } from "@/lib/utils"
import { BOARDS, PERIOD_KINDS, adminPeriodOptions, type Board, type PeriodKind } from "@/lib/leaderboard/periods"
import { PRIZE_RANKS, prizeSummary, type PrizeRank, type PrizeRow } from "@/lib/leaderboard/prizes"
import { formatCedis, type PeriodView } from "@/lib/leaderboard/public"
import type { PeriodRow, StandingRow } from "@/lib/leaderboard/admin"
import { leaderboardFetch } from "../api"
import { PrizeFormDialog, type PackageOption, type PresetOption } from "./PrizeFormDialog"

interface Overview {
  config: { paused: boolean }
  period: PeriodView & { row: PeriodRow | null }
  prizes: PrizeRow[]
  standings: Record<Board, StandingRow[]>
  presets: PresetOption[]
  packages: PackageOption[]
}

interface Exclusion { user_id: string; reason: string | null; created_at: string; email: string | null; name: string | null }

const KIND_LABEL: Record<PeriodKind, string> = { daily: "Daily", weekly: "Weekly", monthly: "Monthly", yearly: "Yearly" }
const BOARD_TITLE: Record<Board, string> = { dashboard: "Dashboard sales", shop: "Shop sales" }

export function LeaderboardAdminPage() {
  const [kind, setKind] = useState<PeriodKind>("monthly")
  const options = useMemo(() => adminPeriodOptions(kind, new Date()), [kind])
  const [anchor, setAnchor] = useState(() => options.find((o) => o.current)!.anchor)
  const [data, setData] = useState<Overview | null>(null)
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(true)
  const seq = useRef(0)

  const [editing, setEditing] = useState<{ board: Board; rank: PrizeRank; prize: PrizeRow | null } | null>(null)
  const [cancelling, setCancelling] = useState<PrizeRow | null>(null)
  const [confirmPause, setConfirmPause] = useState(false)
  const [presetOpen, setPresetOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const mine = ++seq.current
    setLoading(true)
    const res = await leaderboardFetch<Overview>(`/api/admin/leaderboard?${new URLSearchParams({ kind, anchor })}`)
    if (mine !== seq.current) return
    setLoading(false)
    if (res.ok) { setData(res.data); setError("") }
    else setError(res.error)
  }, [kind, anchor])

  useEffect(() => { load() }, [load])

  const chooseKind = (k: PeriodKind) => {
    setKind(k)
    setAnchor(adminPeriodOptions(k, new Date()).find((o) => o.current)!.anchor)
    setData(null)
  }

  const row = data?.period.row ?? null
  const isOpen = !row || row.status === "open"
  const rewardsOn = row?.rewards_enabled ?? false

  async function togglePause() {
    if (!data) return
    setBusy(true)
    const res = await leaderboardFetch("/api/admin/leaderboard/config", { method: "POST", body: { paused: !data.config.paused } })
    setBusy(false)
    setConfirmPause(false)
    if (!res.ok) return toast.error(res.error)
    toast.success(data.config.paused ? "Program resumed" : "Program paused")
    load()
  }

  async function toggleRewards(on: boolean) {
    setBusy(true)
    const res = await leaderboardFetch("/api/admin/leaderboard/period", { method: "POST", body: { kind, anchor, rewards_enabled: on } })
    setBusy(false)
    if (!res.ok) return toast.error(res.error)
    toast.success(on ? "Prizes switched on for this period" : "Prizes switched off for this period")
    load()
  }

  async function savePrize({ prize }: { prize: Record<string, unknown> }) {
    if (!editing) return "Nothing to save"
    const res = await leaderboardFetch("/api/admin/leaderboard/prizes", {
      method: "POST",
      body: { kind, anchor, board: editing.board, rank: editing.rank, prize },
    })
    if (!res.ok) return res.error
    toast.success("Prize saved")
    load()
    return null
  }

  async function cancelPrize() {
    if (!cancelling) return
    setBusy(true)
    const res = await leaderboardFetch(`/api/admin/leaderboard/prizes/${cancelling.id}/cancel`, { method: "POST" })
    setBusy(false)
    setCancelling(null)
    if (!res.ok) return toast.error(res.error)
    toast.success("Prize cancelled")
    load()
  }

  async function savePreset({ name, prize }: { name?: string; prize: Record<string, unknown> }) {
    const res = await leaderboardFetch("/api/admin/leaderboard/presets", { method: "POST", body: { name, prize } })
    if (!res.ok) return res.error
    toast.success("Preset saved")
    load()
    return null
  }

  async function deletePreset(id: string) {
    const res = await leaderboardFetch(`/api/admin/leaderboard/presets/${id}`, { method: "DELETE" })
    if (!res.ok) return toast.error(res.error)
    toast.success("Preset deleted")
    load()
  }

  return (
    <DashboardLayout>
      <div className="mx-auto max-w-5xl space-y-6 pb-10">
        <PageHeaderBanner title="Leaderboard rewards" subtitle="Set the six prizes for a period, then close it to lock in the winners." />

        {/* Program switch */}
        <Card>
          <CardContent className="flex flex-col gap-4 pt-6 sm:flex-row sm:items-center sm:justify-between">
            <div className="space-y-1">
              <p className="flex items-center gap-2 font-bold text-foreground">
                Rewards program
                {data && (data.config.paused ? <Badge variant="destructive">Paused</Badge> : <Badge className="bg-success text-white">Live</Badge>)}
              </p>
              <p className="max-w-md text-sm text-muted-foreground">
                Pausing shows every user a maintenance notice instead of the Top Performers page. Pages may take up to a minute to pick up the change.
              </p>
            </div>
            <Button variant="outline" className="shrink-0" disabled={!data || busy} onClick={() => setConfirmPause(true)}>
              {data?.config.paused ? "Resume program" : "Pause program"}
            </Button>
          </CardContent>
        </Card>

        {/* Period picker */}
        <div className="grid gap-3 sm:grid-cols-[180px_1fr_auto] sm:items-end">
          <div className="space-y-1.5">
            <Label>Period type</Label>
            <Select value={kind} onValueChange={(v) => chooseKind(v as PeriodKind)}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                {PERIOD_KINDS.map((k) => <SelectItem key={k} value={k}>{KIND_LABEL[k]}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Period</Label>
            <Select value={anchor} onValueChange={setAnchor}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent className="max-h-80">
                {options.map((o) => <SelectItem key={o.anchor} value={o.anchor}>{o.label}{o.current ? " (current)" : ""}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <Button variant="outline" size="icon" onClick={load} disabled={loading} aria-label="Reload">
            <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
          </Button>
        </div>

        {error && !data && (
          <Card><CardContent className="space-y-3 pt-6 text-center">
            <p className="text-sm text-destructive">{error}</p>
            <Button variant="outline" onClick={load}>Try again</Button>
          </CardContent></Card>
        )}

        {!data && !error && <Skeleton className="h-96 rounded-2xl" />}

        {data && (
          <>
            <Card>
              <CardContent className="flex items-center justify-between gap-4 pt-6">
                <div>
                  <p className="font-semibold text-foreground">Give prizes for {data.period.label}</p>
                  <p className="text-sm text-muted-foreground">
                    {!isOpen
                      ? "This period is closed. Its prizes are locked."
                      : rewardsOn
                        ? "Users see these prizes on Top Performers. All six must be set before the period can be closed with rewards."
                        : "Off: this period is a ranking only. Prizes you set stay hidden from users until you switch this on."}
                  </p>
                </div>
                <Switch checked={rewardsOn} disabled={busy || !isOpen} onCheckedChange={toggleRewards} aria-label="Give prizes for this period" />
              </CardContent>
            </Card>

            <Tabs defaultValue="prizes">
              <TabsList className="flex h-auto flex-wrap">
                <TabsTrigger value="prizes">Prizes</TabsTrigger>
                <TabsTrigger value="standings">Live standings</TabsTrigger>
                <TabsTrigger value="presets">Presets</TabsTrigger>
                <TabsTrigger value="exclusions">Exclusions</TabsTrigger>
              </TabsList>

              <TabsContent value="prizes" className="space-y-4 pt-2">
                <h2 className="text-xl font-bold text-foreground">Prizes for {data.period.label}</h2>
                <div className="grid gap-4 lg:grid-cols-2">
                  {BOARDS.map((board) => (
                    <Card key={board}>
                      <CardHeader className="pb-2"><CardTitle className="text-base">{BOARD_TITLE[board]}</CardTitle></CardHeader>
                      <CardContent className="divide-y divide-border">
                        {PRIZE_RANKS.map((rank) => {
                          const forRank = data.prizes.filter((p) => p.board === board && p.rank === rank)
                          const active = forRank.find((p) => p.status === "active") ?? null
                          const cancelled = forRank.filter((p) => p.status === "cancelled")
                          return (
                            <div key={rank} className="space-y-2 py-3">
                              <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0">
                                  <p className="font-semibold text-foreground">Rank {rank}</p>
                                  {active ? (
                                    <p className="flex items-center gap-1.5 text-sm text-foreground"><Gift className="h-4 w-4 shrink-0 text-primary" />{prizeSummary(active)}</p>
                                  ) : (
                                    <p className="text-sm text-muted-foreground">No prize set</p>
                                  )}
                                </div>
                                {isOpen && (
                                  <div className="flex shrink-0 gap-1">
                                    <Button size="sm" variant="outline" onClick={() => setEditing({ board, rank, prize: active })}>
                                      {active ? <><Pencil className="h-3.5 w-3.5" /> Edit</> : "Set prize"}
                                    </Button>
                                    {active && (
                                      <Button size="sm" variant="ghost" className="text-destructive" onClick={() => setCancelling(active)} aria-label={`Cancel rank ${rank} prize`}>
                                        <X className="h-4 w-4" />
                                      </Button>
                                    )}
                                  </div>
                                )}
                              </div>
                              {cancelled.map((p) => (
                                <div key={p.id} className="text-sm text-muted-foreground/80">
                                  <p className="line-through decoration-muted-foreground/50">{prizeSummary(p)}</p>
                                  <p className="text-xs">Cancelled. This prize cannot be reassigned.</p>
                                </div>
                              ))}
                            </div>
                          )
                        })}
                      </CardContent>
                    </Card>
                  ))}
                </div>
              </TabsContent>

              <TabsContent value="standings" className="space-y-4 pt-2">
                <p className="text-sm text-muted-foreground">
                  Live top 10 for {data.period.label}. Totals refresh every 5 minutes. Admins and excluded users are never ranked.
                </p>
                <div className="grid gap-4 lg:grid-cols-2">
                  {BOARDS.map((board) => (
                    <Card key={board}>
                      <CardHeader className="pb-2"><CardTitle className="text-base">{BOARD_TITLE[board]}</CardTitle></CardHeader>
                      <CardContent>
                        {data.standings[board].length === 0 ? (
                          <p className="py-6 text-center text-sm text-muted-foreground">No completed sales yet.</p>
                        ) : (
                          <ol className="divide-y divide-border">
                            {data.standings[board].map((s) => (
                              <li key={s.userId} className="flex items-center gap-3 py-2.5">
                                <span className="w-6 shrink-0 text-center font-bold text-foreground">{s.rank}</span>
                                <div className="min-w-0 flex-1">
                                  <p className="truncate font-semibold text-foreground">{s.name}</p>
                                  <p className="truncate text-xs text-muted-foreground">{[s.email, s.phone].filter(Boolean).join(" · ")}</p>
                                </div>
                                <div className="shrink-0 text-right">
                                  <p className="text-sm font-semibold tabular-nums text-foreground">{formatCedis(s.total)}</p>
                                  <p className="text-xs text-muted-foreground">{s.orders} orders</p>
                                </div>
                              </li>
                            ))}
                          </ol>
                        )}
                      </CardContent>
                    </Card>
                  ))}
                </div>
              </TabsContent>

              <TabsContent value="presets" className="space-y-4 pt-2">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm text-muted-foreground">Saved prizes you can reuse when setting a rank&apos;s prize.</p>
                  <Button onClick={() => setPresetOpen(true)}>New preset</Button>
                </div>
                <Card>
                  <CardContent className="divide-y divide-border pt-2">
                    {data.presets.length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">No presets yet.</p>}
                    {data.presets.map((p) => (
                      <div key={p.id} className="flex items-center justify-between gap-3 py-3">
                        <div className="min-w-0">
                          <p className="font-semibold text-foreground">{p.name}</p>
                          <p className="truncate text-sm text-muted-foreground">{prizeSummary(p)}</p>
                        </div>
                        <Button size="sm" variant="ghost" className="text-destructive" onClick={() => deletePreset(p.id)} aria-label={`Delete preset ${p.name}`}>
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    ))}
                  </CardContent>
                </Card>
              </TabsContent>

              <TabsContent value="exclusions" className="pt-2">
                <ExclusionsPanel onChanged={load} />
              </TabsContent>
            </Tabs>
          </>
        )}
      </div>

      <PrizeFormDialog
        open={!!editing}
        onOpenChange={(o) => { if (!o) setEditing(null) }}
        mode="prize"
        title={editing ? `${BOARD_TITLE[editing.board]} · Rank ${editing.rank}` : ""}
        description={data ? `Prize for ${data.period.label}` : ""}
        initial={editing?.prize}
        presets={data?.presets ?? []}
        packages={data?.packages ?? []}
        onSubmit={savePrize}
      />

      <PrizeFormDialog
        open={presetOpen}
        onOpenChange={setPresetOpen}
        mode="preset"
        title="New preset"
        description="Save a prize to reuse across periods."
        presets={[]}
        packages={data?.packages ?? []}
        onSubmit={savePreset}
      />

      <AlertDialog open={!!cancelling} onOpenChange={(o) => { if (!o) setCancelling(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel this prize?</AlertDialogTitle>
            <AlertDialogDescription>
              {cancelling && prizeSummary(cancelling)} will stay listed as cancelled and can never be given to anyone.
              While the period is open you can set a new prize for this rank.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Keep prize</AlertDialogCancel>
            <AlertDialogAction onClick={cancelPrize} disabled={busy} className="bg-destructive hover:bg-destructive/90">Cancel prize</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmPause} onOpenChange={setConfirmPause}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{data?.config.paused ? "Resume the program?" : "Pause the program?"}</AlertDialogTitle>
            <AlertDialogDescription>
              {data?.config.paused
                ? "Users will see the Top Performers rankings again."
                : "Every user will see a maintenance notice instead of the Top Performers page. Rankings keep counting in the background."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Back</AlertDialogCancel>
            <AlertDialogAction onClick={togglePause} disabled={busy}>
              {busy && <Loader2 className="h-4 w-4 animate-spin" />} {data?.config.paused ? "Resume" : "Pause"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </DashboardLayout>
  )
}

function ExclusionsPanel({ onChanged }: { onChanged: () => void }) {
  const [rows, setRows] = useState<Exclusion[] | null>(null)
  const [email, setEmail] = useState("")
  const [reason, setReason] = useState("")
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    const res = await leaderboardFetch<{ exclusions: Exclusion[] }>("/api/admin/leaderboard/exclusions")
    if (res.ok) setRows(res.data.exclusions)
    else toast.error(res.error)
  }, [])

  useEffect(() => { load() }, [load])

  async function add() {
    setSaving(true)
    const res = await leaderboardFetch("/api/admin/leaderboard/exclusions", { method: "POST", body: { email, reason } })
    setSaving(false)
    if (!res.ok) return toast.error(res.error)
    toast.success("User hidden from the leaderboards")
    setEmail("")
    setReason("")
    load()
    onChanged()
  }

  async function remove(userId: string) {
    const res = await leaderboardFetch(`/api/admin/leaderboard/exclusions?${new URLSearchParams({ userId })}`, { method: "DELETE" })
    if (!res.ok) return toast.error(res.error)
    toast.success("User is back on the leaderboards")
    load()
    onChanged()
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Hidden users</CardTitle>
        <CardDescription>Test and staff accounts that should never rank. Admins are always hidden.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
          <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="User's email" aria-label="User's email" />
          <Input value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} placeholder="Reason (optional)" aria-label="Reason" />
          <Button onClick={add} disabled={saving || !email.trim()}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserX className="h-4 w-4" />} Hide
          </Button>
        </div>
        <div className="divide-y divide-border">
          {rows === null && <Skeleton className="h-12" />}
          {rows?.length === 0 && <p className="py-4 text-center text-sm text-muted-foreground">Nobody is hidden.</p>}
          {rows?.map((r) => (
            <div key={r.user_id} className="flex items-center justify-between gap-3 py-2.5">
              <div className="min-w-0">
                <p className="truncate font-semibold text-foreground">{r.name ?? r.email ?? r.user_id}</p>
                <p className="truncate text-xs text-muted-foreground">{[r.email, r.reason].filter(Boolean).join(" · ")}</p>
              </div>
              <Button size="sm" variant="outline" onClick={() => remove(r.user_id)}>Unhide</Button>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}
