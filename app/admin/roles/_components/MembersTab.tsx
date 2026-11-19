"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"
import { validateReason } from "@/lib/roles/admin/validate"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { adminFetch } from "../_lib/api"
import type { HubRole } from "../_lib/ladder-view"
import {
  MAX_SELECT, MOVE_CHUNK, addTally, chunk, collectAllIds, emptyTally, moveTargets, tallyText,
  type MoveResult, type Tally,
} from "../_lib/members-move"
import type { EditTabProps } from "../_lib/tab-props"

const PAGE_SIZE = 50
const MAX_RESULT_ROWS = 500

export interface MemberRow {
  id: string
  name: string
  email: string | null
  phone: string | null
}

export interface MembersViewProps {
  roles: HubRole[]
  currentRoleId: string
  members: MemberRow[]
  total: number
  page: number
  q: string
  onQ: (q: string) => void
  onSearch: () => void
  onPage: (p: number) => void
  selected: ReadonlySet<string>
  onToggle: (id: string) => void
  onSelectPage: () => void
  onSelectAll: () => void
  onClear: () => void
  selectNote: string | null
  target: string
  onTarget: (slug: string) => void
  reason: string
  onReason: (r: string) => void
  busy: boolean
  loading: boolean
  tally: Tally | null
  results: MoveResult[]
  onMove: () => void
  error: string | null
  /** Names seen on any page so far, so result rows can show a name instead of an id. */
  names?: ReadonlyMap<string, string>
}

export function MembersView(p: MembersViewProps) {
  const targets = moveTargets(p.roles, p.currentRoleId)
  const pages = Math.max(1, Math.ceil(p.total / PAGE_SIZE))
  const canMove = !p.busy && p.selected.size > 0 && p.target !== "" && validateReason(p.reason).ok
  const nameOf = new Map<string, string>([...(p.names ?? []), ...p.members.map((m): [string, string] => [m.id, m.name])])
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3 lg:items-start">
      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle className="text-base">Members ({p.total})</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              p.onSearch()
            }}
          >
            <Input aria-label="Search members" placeholder="Search name, email or phone" value={p.q} maxLength={64} onChange={(e) => p.onQ(e.target.value)} />
            <Button type="submit" variant="outline" disabled={p.busy || p.loading}>
              Search
            </Button>
          </form>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Button type="button" size="sm" variant="outline" onClick={p.onSelectPage} disabled={p.busy || p.members.length === 0}>
              Select this page
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={p.onSelectAll} disabled={p.busy || p.total === 0}>
              Select all {p.total} matching
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={p.onClear} disabled={p.busy || p.selected.size === 0}>
              Clear
            </Button>
            <span className="text-muted-foreground">{p.selected.size} selected</span>
          </div>
          {p.selectNote ? <p className="text-xs text-muted-foreground" data-select-note>{p.selectNote}</p> : null}
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <tbody>
                {p.members.map((m) => (
                  <tr key={m.id} className="border-t first:border-t-0">
                    <td className="w-8 p-2">
                      <input
                        type="checkbox"
                        aria-label={`Select ${m.name || "member"}`}
                        checked={p.selected.has(m.id)}
                        disabled={p.busy}
                        onChange={() => p.onToggle(m.id)}
                      />
                    </td>
                    <td className="p-2">{m.name || "(no name)"}</td>
                    <td className="p-2 text-muted-foreground">{m.email ?? ""}</td>
                    <td className="p-2 text-muted-foreground">{m.phone ?? ""}</td>
                  </tr>
                ))}
                {p.members.length === 0 ? (
                  <tr>
                    <td className="p-6 text-center text-muted-foreground">{p.loading ? "Loading..." : "No members found"}</td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between text-sm">
            <Button type="button" size="sm" variant="outline" disabled={p.busy || p.loading || p.page <= 1} onClick={() => p.onPage(p.page - 1)}>
              Previous
            </Button>
            <span className="text-muted-foreground">
              Page {p.page} of {pages}
            </span>
            <Button type="button" size="sm" variant="outline" disabled={p.busy || p.loading || p.page >= pages} onClick={() => p.onPage(p.page + 1)}>
              Next
            </Button>
          </div>
        </CardContent>
      </Card>

      <div className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Move selected members</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="move-target">Move to</Label>
              <select
                id="move-target"
                value={p.target}
                onChange={(e) => p.onTarget(e.target.value)}
                disabled={p.busy}
                className="h-9 w-full rounded-md border bg-background px-2 text-sm"
              >
                <option value="">Choose a role</option>
                {targets.map((r) => (
                  <option key={r.id} value={r.slug}>
                    {r.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="move-reason">Reason</Label>
              <Input
                id="move-reason"
                value={p.reason}
                maxLength={300}
                placeholder="Why are you moving them? (min 3 characters)"
                onChange={(e) => p.onReason(e.target.value)}
              />
            </div>
            <Button data-move-go onClick={p.onMove} disabled={!canMove}>
              {p.busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Move {p.selected.size} member{p.selected.size === 1 ? "" : "s"}
            </Button>
            {p.error ? <p className="text-sm text-destructive">{p.error}</p> : null}
          </CardContent>
        </Card>

        {p.tally ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Result</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <p className="text-sm font-medium" data-tally>
                {tallyText(p.tally)}
              </p>
              <div className="max-h-72 overflow-auto rounded-md border">
                <table className="w-full text-xs">
                  <tbody>
                    {p.results.slice(0, MAX_RESULT_ROWS).map((r) => (
                      <tr key={r.user_id} className="border-t first:border-t-0" data-result={r.status}>
                        <td className="p-2">{nameOf.get(r.user_id) || r.user_id.slice(0, 8)}</td>
                        <td className={`p-2 ${r.status === "error" ? "text-destructive" : ""}`}>{r.status}</td>
                        <td className="p-2 text-muted-foreground">{r.reason ?? r.note ?? ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {p.results.length > MAX_RESULT_ROWS ? (
                <p className="text-xs text-muted-foreground">Showing the first {MAX_RESULT_ROWS} of {p.results.length} rows.</p>
              ) : null}
            </CardContent>
          </Card>
        ) : null}
      </div>
    </div>
  )
}

interface MembersResponse {
  members: MemberRow[]
  total: number
  page: number
}

const membersUrl = (roleId: string, q: string, page: number) =>
  `/api/admin/roles/${roleId}/members?q=${encodeURIComponent(q)}&page=${page}`

export function MembersTab({ role, roles, busy, setBusy, onError, onDirtyChange, onChanged }: EditTabProps) {
  const [members, setMembers] = useState<MemberRow[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [q, setQ] = useState("")
  const [appliedQ, setAppliedQ] = useState("")
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [selectNote, setSelectNote] = useState<string | null>(null)
  const [target, setTarget] = useState("")
  const [reason, setReason] = useState("")
  const [tally, setTally] = useState<Tally | null>(null)
  const [results, setResults] = useState<MoveResult[]>([])
  const [error, setError] = useState<string | null>(null)
  const names = useRef(new Map<string, string>())

  const load = useCallback(
    async (nextPage: number, query: string) => {
      setLoading(true)
      setError(null)
      try {
        const data = await adminFetch<MembersResponse>(membersUrl(role.id, query, nextPage))
        setMembers(data.members)
        setTotal(data.total)
        setPage(data.page)
        for (const m of data.members) names.current.set(m.id, m.name)
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load members")
      } finally {
        setLoading(false)
      }
    },
    [role.id],
  )

  useEffect(() => {
    load(1, "")
  }, [load])

  useEffect(() => {
    onDirtyChange(selected.size > 0)
    return () => onDirtyChange(false)
  }, [selected.size, onDirtyChange])

  const search = () => {
    setAppliedQ(q)
    setSelected(new Set())
    setSelectNote(null)
    load(1, q)
  }

  const selectAll = async () => {
    if (busy) return
    setBusy(true)
    setSelectNote("Collecting matching members...")
    try {
      const r = await collectAllIds(async (pg) => {
        const d = await adminFetch<MembersResponse>(membersUrl(role.id, appliedQ, pg))
        for (const m of d.members) names.current.set(m.id, m.name)
        return { ids: d.members.map((m) => m.id), total: d.total }
      }, PAGE_SIZE)
      setSelected(new Set(r.ids))
      setSelectNote(
        r.capped
          ? `Selected the first ${MAX_SELECT} of ${total} matching members. Move these, then select again for the rest.`
          : `Selected all ${r.ids.length} matching members.`,
      )
    } catch (e) {
      setSelectNote(null)
      setError(e instanceof Error ? e.message : "Could not collect members")
    } finally {
      setBusy(false)
    }
  }

  const move = async () => {
    if (busy) return
    const v = validateReason(reason)
    if (!v.ok || !target || selected.size === 0) return
    setBusy(true)
    setError(null)
    let t = emptyTally()
    let all: MoveResult[] = []
    setTally(t)
    setResults([])
    try {
      for (const ids of chunk([...selected], MOVE_CHUNK)) {
        try {
          const r = await adminFetch<{ results: MoveResult[] }>("/api/admin/roles/members/move", {
            method: "POST",
            body: { user_ids: ids, to_role: target, reason: v.value },
          })
          all = all.concat(r.results)
          t = addTally(t, r.results)
        } catch (e) {
          // A failed chunk becomes per-user error rows; later chunks still run.
          const msg = e instanceof Error ? e.message : "Request failed"
          const rows: MoveResult[] = ids.map((user_id) => ({ user_id, status: "error", reason: msg }))
          all = all.concat(rows)
          t = addTally(t, rows)
        }
        setTally(t)
        setResults(all)
      }
      if (t.moved > 0) toast.success(`Moved ${t.moved} member${t.moved === 1 ? "" : "s"}`)
      else toast.error("No members were moved. See the results for the reasons.")
      setSelected(new Set())
      setSelectNote(null)
      await load(1, appliedQ)
      await onChanged?.()
    } catch (e) {
      await onError(e)
    } finally {
      setBusy(false)
    }
  }

  return (
    <MembersView
      roles={roles}
      currentRoleId={role.id}
      members={members}
      total={total}
      page={page}
      q={q}
      onQ={setQ}
      onSearch={search}
      onPage={(p) => load(p, appliedQ)}
      selected={selected}
      onToggle={(id) =>
        setSelected((cur) => {
          const n = new Set(cur)
          if (n.has(id)) n.delete(id)
          else n.add(id)
          return n
        })
      }
      onSelectPage={() => setSelected((cur) => new Set([...cur, ...members.map((m) => m.id)]))}
      onSelectAll={selectAll}
      onClear={() => {
        setSelected(new Set())
        setSelectNote(null)
      }}
      selectNote={selectNote}
      target={target}
      onTarget={setTarget}
      reason={reason}
      onReason={setReason}
      busy={busy}
      loading={loading}
      tally={tally}
      results={results}
      onMove={move}
      error={error}
      names={names.current}
    />
  )
}
