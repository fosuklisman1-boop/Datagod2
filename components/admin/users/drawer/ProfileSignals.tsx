"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Loader2, Plus, X } from "lucide-react"
import { toast } from "sonner"
import { adminJson, userApiPath } from "@/lib/admin-users/drawer-client"
import { SUGGESTED_TAGS, normaliseTag } from "@/lib/admin-users/notes-tags"
import type { UserSignalsView } from "@/lib/admin-users/risk-signals"
import { PhoneMarkers, RiskFlagIcons } from "../UserSignals"
import { dateTime, useAdminGet } from "./shared"

/** Activity and risk signals on the Profile tab: last order, phone verified / blacklisted, the risk flags. */
export function ProfileSignals({ userId, refreshKey = 0 }: { userId: string; refreshKey?: number }) {
  const { data, error, loading } = useAdminGet<{ signals: UserSignalsView | null }>(userApiPath(userId, "signals"), refreshKey)
  const s = data?.signals
  if (error) return <p className="text-xs text-muted-foreground">Activity signals unavailable: {error}</p>
  if (!s) return loading ? <p className="text-xs text-muted-foreground inline-flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> Loading activity…</p> : null
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
        <span><span className="text-xs text-muted-foreground">Last order </span>{s.lastOrderAt ? dateTime(s.lastOrderAt) : "None"}</span>
        <span className="inline-flex items-center gap-1">
          <span className="text-xs text-muted-foreground">Phone</span>
          {s.phoneBlacklisted ? <span className="text-destructive text-xs font-medium">blacklisted</span> : <span className="text-xs">not blacklisted</span>}
          <PhoneMarkers signals={s} />
        </span>
      </div>
      {s.flags.length > 0 ? (
        <ul className="space-y-1 rounded-md border border-warning/50 bg-warning/5 p-2 text-xs" aria-label="Risk flags">
          {s.flags.map((f) => (
            <li key={f.code} className="flex items-start gap-1"><RiskFlagIcons flags={[f]} /><span>{f.reason}</span></li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">No risk flags.</p>
      )}
    </div>
  )
}

/** The user's admin tags as removable chips, with an input that suggests the common tags. */
export function TagsEditor({ userId, refreshKey = 0, onChanged }: { userId: string; refreshKey?: number; onChanged: () => void }) {
  const { data, error, reload } = useAdminGet<{ tags: string[]; suggested: string[] }>(userApiPath(userId, "tags"), refreshKey)
  const [text, setText] = useState("")
  const [busy, setBusy] = useState(false)
  const tags = data?.tags ?? []

  const change = async (body: { add?: string[]; remove?: string[] }) => {
    setBusy(true)
    try {
      await adminJson(userApiPath(userId, "tags"), { method: "POST", body })
      reload()
      onChanged()
    } catch (e: any) {
      toast.error(e?.message || "Could not change tags")
    } finally {
      setBusy(false)
    }
  }
  const candidate = normaliseTag(text)
  const suggestions = SUGGESTED_TAGS.filter((t) => !tags.includes(t))

  if (error) return <p className="text-xs text-muted-foreground">Tags unavailable: {error}</p>
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1">
        {tags.length === 0 && <span className="text-xs text-muted-foreground">No tags</span>}
        {tags.map((t) => (
          <span key={t} className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs">
            {t}
            <button type="button" aria-label={`Remove tag ${t}`} disabled={busy} onClick={() => change({ remove: [t] })}
              className="text-muted-foreground hover:text-destructive disabled:opacity-50">
              <X className="w-3 h-3" />
            </button>
          </span>
        ))}
      </div>
      <form className="flex items-center gap-2" onSubmit={(e) => {
        e.preventDefault()
        if (candidate && !tags.includes(candidate)) change({ add: [candidate] }).then(() => setText(""))
      }}>
        <Input list={`tag-suggestions-${userId}`} value={text} onChange={(e) => setText(e.target.value)} placeholder="Add a tag"
          aria-label="Add a tag" aria-invalid={!!text.trim() && !candidate} className="h-8 text-xs sm:w-48" maxLength={32} />
        <datalist id={`tag-suggestions-${userId}`}>{suggestions.map((t) => <option key={t} value={t} />)}</datalist>
        <Button type="submit" size="sm" variant="outline" className="h-8 gap-1" disabled={busy || !candidate || tags.includes(candidate)}>
          {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />} Add
        </Button>
      </form>
      {text.trim() && !candidate && <p className="text-xs text-destructive">Tags are 1 to 32 characters: a-z, 0-9 and -</p>}
      {suggestions.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {suggestions.map((t) => (
            <button key={t} type="button" disabled={busy} onClick={() => change({ add: [t] })}
              className="rounded-full border border-dashed px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50">
              + {t}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
