"use client"

import { useEffect, useState } from "react"
import { AlertTriangle, Info, OctagonAlert, X } from "lucide-react"
import type { LucideIcon } from "lucide-react"
import type { AnnouncementSeverity, PublicAnnouncement } from "@/lib/api-v2/announcements"
import { cn } from "@/lib/utils"

const STYLE: Record<AnnouncementSeverity, { label: string; icon: LucideIcon; box: string; text: string }> = {
  info: { label: "Notice", icon: Info, box: "border-primary/30 bg-primary/[0.06] dark:bg-primary/10", text: "text-primary" },
  warning: { label: "Warning", icon: AlertTriangle, box: "border-amber-500/40 bg-amber-500/[0.08] dark:bg-amber-500/10", text: "text-amber-700 dark:text-amber-300" },
  critical: { label: "Critical", icon: OctagonAlert, box: "border-rose-500/40 bg-rose-500/[0.08] dark:bg-rose-500/10", text: "text-rose-700 dark:text-rose-300" },
}

/** Plain text only: React escapes the title and body; there is no markdown, link or HTML rendering. */
export function AnnouncementBannerView({ items, dismissed, onDismiss }: { items: PublicAnnouncement[]; dismissed: string[]; onDismiss: (id: string) => void }) {
  const shown = items.filter((a) => a.severity === "critical" || !dismissed.includes(a.id))
  if (shown.length === 0) return null
  return (
    <div className="space-y-2" aria-label="Announcements">
      {shown.map((a) => {
        const s = STYLE[a.severity] ?? STYLE.info
        const Icon = s.icon
        return (
          <div key={a.id} role={a.severity === "critical" ? "alert" : "status"} className={cn("flex gap-3 rounded-xl border p-3 text-sm", s.box)}>
            <Icon className={cn("mt-0.5 size-4 shrink-0", s.text)} aria-hidden />
            <div className="min-w-0 flex-1">
              <p className={cn("font-semibold", s.text)}>
                <span className="mr-1.5 rounded-full border border-current px-1.5 text-[11px] font-bold uppercase tracking-wide">{s.label}</span>
                <span className="break-words text-foreground">{a.title}</span>
              </p>
              <p className="mt-1 whitespace-pre-line break-words text-muted-foreground">{a.body}</p>
            </div>
            {a.severity !== "critical" && (
              <button type="button" onClick={() => onDismiss(a.id)} aria-label={`Dismiss ${a.title}`} className="h-7 w-7 shrink-0 rounded-lg text-muted-foreground hover:bg-muted">
                <X className="mx-auto size-4" aria-hidden />
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}

const KEY = "datagod:dismissed-announcements"

function readDismissed(): string[] {
  try {
    const v = JSON.parse(window.sessionStorage.getItem(KEY) ?? "[]")
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []
  } catch {
    return []
  }
}

/** Fetches the public announcements once. Any failure renders nothing: an announcement never breaks a page. */
export function AnnouncementBanner({ className }: { className?: string }) {
  const [items, setItems] = useState<PublicAnnouncement[]>([])
  const [dismissed, setDismissed] = useState<string[]>([])

  useEffect(() => {
    setDismissed(readDismissed())
    const ctrl = new AbortController()
    fetch("/api/developers/announcements", { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { announcements?: PublicAnnouncement[] } | null) => {
        if (d && Array.isArray(d.announcements)) setItems(d.announcements)
      })
      .catch(() => {})
    return () => ctrl.abort()
  }, [])

  const dismiss = (id: string) => {
    const next = [...new Set([...dismissed, id])]
    setDismissed(next)
    try {
      window.sessionStorage.setItem(KEY, JSON.stringify(next))
    } catch {
      // storage blocked: the dismissal lasts until the page reloads
    }
  }

  if (items.length === 0) return null
  return (
    <div className={className}>
      <AnnouncementBannerView items={items} dismissed={dismissed} onDismiss={dismiss} />
    </div>
  )
}
