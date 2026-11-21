"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import Link from "next/link"
import { draftCardView, UNKNOWN_MESSAGE, type CardViewState } from "./draft-card-view"

// Confirm card for an AI-prepared action. It renders server state only: every status below comes from
// GET/POST /api/ai/drafts/[id]. The one local fabrication is the "stopped waiting" unknown after 90 s of executing.

export interface DraftCardProps {
  draftId: string
  initial: { display: unknown; expires_at: string; warnings?: string[] }
  getToken: () => Promise<string>
  /** Sends a chat message through the widget's own send function. Never calls an API itself. */
  onPrepareAgain?: () => void
}

const POLL_EVERY_MS = 2000
const POLL_FOR_MS = 90_000

type ServerState = Pick<CardViewState, "status" | "finalStatus" | "outcome" | "display">

async function call(draftId: string, getToken: () => Promise<string>, method: "GET" | "POST", action?: "confirm" | "recheck" | "cancel") {
  const token = await getToken()
  const res = await fetch(`/api/ai/drafts/${draftId}${action ? `/${action}` : ""}`, {
    method,
    headers: { Authorization: `Bearer ${token}` },
  })
  if (res.ok) return { ok: true as const, state: (await res.json()) as ServerState }
  return { ok: false as const, status: res.status }
}

const HTTP_MESSAGES: Record<number, string> = {
  401: "Please sign in again to continue.",
  404: "This card is no longer available.",
  429: "Too many attempts. Wait a moment and try again.",
  503: "This feature is switched off right now.",
}

export function DraftCard({ draftId, initial, getToken, onPrepareAgain }: DraftCardProps) {
  const [state, setState] = useState<CardViewState>({
    status: "pending",
    outcome: null,
    display: initial.display,
    expires_at: initial.expires_at,
    warnings: initial.warnings ?? [],
  })
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [showItems, setShowItems] = useState(false)
  const busyRef = useRef(false)
  const mounted = useRef(true)

  const apply = useCallback(
    (s: ServerState) => setState((prev) => ({ ...prev, status: s.status, finalStatus: s.finalStatus, outcome: s.outcome, display: s.display ?? prev.display })),
    [],
  )

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  // On mount: the stored server state. Until it answers, no button is live.
  useEffect(() => {
    let cancelled = false
    call(draftId, getToken, "GET")
      .then((r) => {
        if (cancelled) return
        if (r.ok) apply(r.state)
        else setError(HTTP_MESSAGES[r.status] ?? "Could not load this card.")
      })
      .catch(() => !cancelled && setError("Could not load this card."))
      .finally(() => !cancelled && setLoaded(true))
    return () => {
      cancelled = true
    }
  }, [draftId, getToken, apply])

  // Countdown ticks only while pending.
  useEffect(() => {
    if (state.status !== "pending") return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [state.status])

  // While the server says executing (a slow run, or the losing tap of a double tap): poll, then stop and say unknown.
  useEffect(() => {
    if (state.status !== "executing") return
    const startedAt = Date.now()
    const t = setInterval(async () => {
      if (Date.now() - startedAt >= POLL_FOR_MS) {
        clearInterval(t)
        setState((prev) => (prev.status === "executing" ? { ...prev, status: "unknown", outcome: { code: "no_response", message: UNKNOWN_MESSAGE } } : prev))
        return
      }
      try {
        const r = await call(draftId, getToken, "GET")
        if (r.ok && mounted.current) apply(r.state)
      } catch {
        // keep polling until the window closes
      }
    }, POLL_EVERY_MS)
    return () => clearInterval(t)
  }, [state.status, draftId, getToken, apply])

  const act = useCallback(
    async (action: "confirm" | "recheck" | "cancel") => {
      if (busyRef.current) return // one request per click: a second tap before the answer is ignored
      busyRef.current = true
      setBusy(true)
      setError(null)
      try {
        const r = await call(draftId, getToken, "POST", action)
        if (!mounted.current) return
        if (r.ok) apply(r.state)
        else setError(HTTP_MESSAGES[r.status] ?? "Something went wrong. Please try again.")
      } catch {
        // The request may have reached the server. Ask it what happened instead of guessing.
        try {
          const r = await call(draftId, getToken, "GET")
          if (mounted.current) {
            if (r.ok) apply(r.state)
            else setError("We couldn't reach the server. Please try again.")
          }
        } catch {
          if (mounted.current) {
            if (action === "confirm") setState((prev) => ({ ...prev, status: "unknown", outcome: { code: "no_response", message: UNKNOWN_MESSAGE } }))
            else setError("We couldn't reach the server. Please try again.")
          }
        }
      } finally {
        busyRef.current = false
        if (mounted.current) setBusy(false)
      }
    },
    [draftId, getToken, apply],
  )

  const view = draftCardView(state, now)
  const disabled = busy || !loaded
  const tone =
    view.variant === "succeeded"
      ? "border-emerald-500/40"
      : view.variant === "failed" || view.variant === "partial"
        ? "border-destructive/40"
        : "border-primary/30"

  return (
    <div
      className={`w-full max-w-[85%] lg:max-w-md rounded-2xl border bg-card p-3 lg:p-4 text-sm text-foreground shadow-sm ${tone} ${view.greyed ? "opacity-60 grayscale" : ""}`}
      data-variant={view.variant}
    >
      <p className="font-semibold text-primary">{view.title}</p>

      {view.lines.length > 0 && (
        <dl className="mt-2 space-y-1">
          {view.lines.map((l, i) => (
            <div key={i} className="flex justify-between gap-3">
              <dt className="text-muted-foreground">{l.label}</dt>
              <dd className="text-right font-medium break-words">{l.value}</dd>
            </div>
          ))}
        </dl>
      )}

      {view.warnings.map((w, i) => (
        <p key={i} className="mt-2 text-xs text-amber-600 dark:text-amber-400">
          {w}
        </p>
      ))}

      {/* Status changes are announced politely; the countdown below is deliberately not live. */}
      <div aria-live="polite" role="status" className="mt-2">
        {view.variant === "executing" && (
          <p className="flex items-center gap-2 text-muted-foreground">
            <span className="h-3 w-3 animate-spin rounded-full border-2 border-primary border-t-transparent" aria-hidden="true" />
            {view.message}
          </p>
        )}
        {view.variant !== "executing" && view.message && (
          <p className={view.variant === "failed" || view.variant === "partial" ? "text-destructive" : view.variant === "succeeded" ? "font-medium text-emerald-600 dark:text-emerald-400" : "text-muted-foreground"}>
            {view.variant === "succeeded" ? "✓ " : ""}
            {view.message}
          </p>
        )}
        {error && <p className="mt-1 text-destructive">{error}</p>}
      </div>

      {view.items.length > 0 && (
        <div className="mt-1">
          <button type="button" onClick={() => setShowItems((v) => !v)} aria-expanded={showItems} className="text-xs font-medium text-primary underline">
            {showItems ? "Hide details" : "Show details"}
          </button>
          {showItems && (
            <ul className="mt-1 list-disc pl-4 text-xs text-muted-foreground">
              {view.items.map((it, i) => (
                <li key={i}>{it}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {view.countdownText && (
        <p className="mt-2 text-xs text-muted-foreground" aria-live="off">
          {view.countdownText}
        </p>
      )}

      {(view.showConfirm || view.showCancel || view.showCheckAgain || view.showPrepareAgain || view.topUpHref) && (
        <div className="mt-3 flex flex-wrap gap-2">
          {view.showConfirm && (
            <button
              type="button"
              disabled={disabled}
              onClick={() => act("confirm")}
              className="rounded-xl bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
            >
              {busy ? "Confirming..." : "Confirm"}
            </button>
          )}
          {view.showCancel && (
            <button
              type="button"
              disabled={disabled}
              onClick={() => act("cancel")}
              className="rounded-xl border border-border bg-card px-4 py-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent disabled:opacity-50"
            >
              Cancel
            </button>
          )}
          {view.showCheckAgain && (
            <button
              type="button"
              disabled={disabled}
              onClick={() => act("recheck")}
              className="rounded-xl bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
            >
              {busy ? "Checking..." : "Check again"}
            </button>
          )}
          {view.topUpHref && (
            <Link href={view.topUpHref} className="rounded-xl bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground hover:bg-primary/90">
              Top up
            </Link>
          )}
          {view.showPrepareAgain && onPrepareAgain && (
            <button
              type="button"
              onClick={onPrepareAgain}
              className="rounded-xl border border-primary/30 bg-primary/5 px-4 py-2 text-xs font-semibold text-primary transition-colors hover:bg-primary/10"
            >
              Prepare again
            </button>
          )}
        </div>
      )}
    </div>
  )
}
