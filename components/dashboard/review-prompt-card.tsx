"use client"

import { useEffect, useState } from "react"
import { Star } from "lucide-react"
import { supabase } from "@/lib/supabase"
import {
  REVIEW_CARD_STORAGE_KEY,
  shouldShowReviewCard,
  type ReviewCardState,
} from "@/lib/review-prompt"

function readState(): ReviewCardState | null {
  try {
    const raw = localStorage.getItem(REVIEW_CARD_STORAGE_KEY)
    return raw ? (JSON.parse(raw) as ReviewCardState) : null
  } catch {
    return null
  }
}

function writeState(state: ReviewCardState) {
  try {
    localStorage.setItem(REVIEW_CARD_STORAGE_KEY, JSON.stringify(state))
  } catch {
    /* storage unavailable */
  }
}

export function ReviewPromptCard() {
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        if (!shouldShowReviewCard(readState(), new Date())) return
        const token = (await supabase.auth.getSession()).data.session?.access_token
        if (!token) return
        const res = await fetch("/api/review-prompt", { headers: { Authorization: `Bearer ${token}` } })
        if (!res.ok) return
        const data = await res.json()
        if (!cancelled && data.show && typeof data.url === "string") setUrl(data.url)
      } catch {
        /* card is optional */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  if (!url) return null

  return (
    <div className="fixed bottom-20 left-4 right-4 z-40 mx-auto max-w-sm rounded-2xl border border-border bg-card p-4 shadow-lg sm:left-auto sm:right-6 sm:bottom-6">
      <div className="flex items-start gap-3">
        <Star className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">Enjoying DATAGOD? Leave us a Google review</p>
          <p className="mt-1 text-sm text-muted-foreground">A quick Google review helps other people find us.</p>
          <div className="mt-3 flex items-center gap-2">
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => {
                writeState({ clicked: true })
                setUrl(null)
              }}
              className="inline-flex h-9 items-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground"
            >
              Rate us on Google
            </a>
            <button
              type="button"
              onClick={() => {
                writeState({ dismissedAt: new Date().toISOString() })
                setUrl(null)
              }}
              className="h-9 rounded-lg px-3 text-sm text-muted-foreground hover:text-foreground"
            >
              Not now
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
