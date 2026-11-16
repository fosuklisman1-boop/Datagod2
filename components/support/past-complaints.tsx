"use client"

import { useEffect, useState } from "react"
import { ChevronDown } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { supabase } from "@/lib/supabase"

interface LegacyComplaint {
  id: string
  title: string
  status: string
  resolution_notes: string | null
  created_at: string
}

/** The user's old one-shot complaints, read-only. */
export function PastComplaints({ userId }: { userId: string }) {
  const [rows, setRows] = useState<LegacyComplaint[]>([])

  useEffect(() => {
    let cancelled = false
    supabase
      .from("complaints")
      .select("id, title, status, resolution_notes, created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(100)
      .then(({ data }) => {
        if (!cancelled) setRows((data ?? []) as LegacyComplaint[])
      })
    return () => {
      cancelled = true
    }
  }, [userId])

  if (rows.length === 0) return null
  return (
    <Collapsible className="rounded-2xl border border-border bg-card">
      <CollapsibleTrigger className="flex w-full items-center justify-between px-4 py-3 text-sm font-semibold text-foreground">
        Past order complaints ({rows.length})
        <ChevronDown className="h-4 w-4" />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul className="divide-y divide-border border-t border-border">
          {rows.map((c) => (
            <li key={c.id} className="space-y-1 px-4 py-3">
              <div className="flex items-start justify-between gap-3">
                <p className="text-sm font-medium text-foreground">{c.title}</p>
                <Badge variant="outline" className="shrink-0 capitalize">{c.status.replace("_", " ")}</Badge>
              </div>
              <p className="text-xs text-muted-foreground">{new Date(c.created_at).toLocaleDateString()}</p>
              {c.resolution_notes && (
                <p className="rounded-lg bg-muted/50 p-2 text-sm text-muted-foreground whitespace-pre-wrap">{c.resolution_notes}</p>
              )}
            </li>
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  )
}
