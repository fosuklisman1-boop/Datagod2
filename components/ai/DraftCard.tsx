"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import Link from "next/link"
import {
  adminCardTone,
  buildConfirmSecrets,
  clearsSecrets,
  confirmErrorMessage,
  draftCardView,
  secretsReady,
  UNKNOWN_MESSAGE,
  type CardViewState,
  type LoadError,
  type SecretField,
} from "./draft-card-view"

// Confirm card for an AI-prepared action. It renders server state only: every status below comes from
// GET/POST /api/ai/drafts/[id]. The one local fabrication is the "stopped waiting" unknown after 90 s of executing.

export interface DraftCardProps {
  draftId: string
  initial: { display: unknown; expires_at: string; warnings?: string[]; status?: string; outcome?: Record<string, unknown> | null }
  getToken: () => Promise<string>
  /** Sends a chat message through the widget's own send function. Never calls an API itself. */
  onPrepareAgain?: () => void
}

const POLL_EVERY_MS = 2000
const POLL_FOR_MS = 90_000

type ServerState = Pick<CardViewState, "status" | "finalStatus" | "outcome" | "display">

async function call(
  draftId: string,
  getToken: () => Promise<string>,
  method: "GET" | "POST",
  action?: "confirm" | "recheck" | "cancel",
  body?: { secrets: Record<string, string> } | null,
) {
  const token = await getToken()
  const res = await fetch(`/api/ai/drafts/${draftId}${action ? `/${action}` : ""}`, {
    method,
    headers: body ? { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } : { Authorization: `Bearer ${token}` },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  if (res.ok) return { ok: true as const, state: (await res.json()) as ServerState }
  const errBody: unknown = await res.json().catch(() => null)
  return { ok: false as const, status: res.status, body: errBody }
}

const HTTP_MESSAGES: Record<number, string> = {
  401: "Please sign in again to continue.",
  404: "This card is no longer available.",
  429: "Too many attempts. Wait a moment and try again.",
  503: "This feature is switched off right now.",
}

export function DraftCard({ draftId, initial, getToken, onPrepareAgain }: DraftCardProps) {
  const [state, setState] = useState<CardViewState>({
    status: initial.status ?? "pending",
    outcome: initial.outcome ?? null,
    display: initial.display,
    expires_at: initial.expires_at,
    warnings: initial.warnings ?? [],
  })
  // loaded = a GET has returned a server status. Until then (or after a failed first load) no action is live.
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState<LoadError | null>(null)
  const [loadTry, setLoadTry] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [showItems, setShowItems] = useState(false)
  // Secure-box values live only in this component's memory: never persisted, logged or put in a message.
  const [secrets, setSecrets] = useState<Record<string, string>>({})
  const [revealed, setRevealed] = useState<Record<string, boolean>>({})
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
      setSecrets({})
    }
  }, [])

  // On mount: the stored server state. Until it answers, no button is live.
  useEffect(() => {
    let cancelled = false
    setLoadError(null)
    call(draftId, getToken, "GET")
      .then((r) => {
        if (cancelled) return
        if (r.ok) {
          apply(r.state)
          setLoaded(true)
        } else {
          setLoadError(r.status === 404 ? "not_found" : r.status === 401 ? "unauthorized" : r.status === 429 ? "rate_limited" : r.status === 503 ? "unavailable" : "network")
        }
      })
      .catch(() => !cancelled && setLoadError("network"))
    return () => {
      cancelled = true
    }
  }, [draftId, getToken, apply, loadTry])

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
    async (action: "confirm" | "recheck" | "cancel", fields: SecretField[] = [], typed: Record<string, string> = {}) => {
      if (busyRef.current) return // one request per click: a second tap before the answer is ignored
      busyRef.current = true
      setBusy(true)
      setError(null)
      try {
        const payload = action === "confirm" ? buildConfirmSecrets(fields, typed) : null
        const r = await call(draftId, getToken, "POST", action, payload)
        if (!mounted.current) return
        if (r.ok) apply(r.state)
        else setError(confirmErrorMessage(r.status, r.body) || HTTP_MESSAGES[r.status] || "Something went wrong. Please try again.")
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
        if (clearsSecrets(action) && mounted.current) {
          // Typed secrets are dropped once a confirm or cancel attempt resolves, success or failure.
          setSecrets({})
          setRevealed({})
        }
        if (mounted.current) setBusy(false)
      }
    },
    [draftId, getToken, apply],
  )

  const view = draftCardView(loaded ? state : { ...state, loadError: loadError ?? undefined }, now)
  const loading = !loaded && !loadError
  const disabled = busy || !loaded
  const confirmBlocked = disabled || !secretsReady(view.secretFields, secrets)
  const tone =
    view.variant === "succeeded"
      ? "border-emerald-500/40"
      : view.variant === "failed" || view.variant === "partial"
        ? "border-destructive/40"
        : view.risk
          ? adminCardTone(view.risk)
          : "border-primary/30"

  return (
    <div
      className={`w-full max-w-[85%] lg:max-w-md rounded-2xl border bg-card p-3 lg:p-4 text-sm text-foreground shadow-sm ${tone} ${view.greyed ? "opacity-60 grayscale" : ""}`}
      data-variant={view.variant}
    >
      <p className="font-semibold text-primary">{view.title}</p>

      {view.riskBadge && view.risk && (
        <span
          className={`mt-1 inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
            view.risk === "danger" ? "bg-destructive/10 text-destructive" : view.risk === "money" ? "bg-amber-500/15 text-amber-700 dark:text-amber-400" : "bg-primary/10 text-primary"
          }`}
        >
          {view.riskBadge}
        </span>
      )}

      {view.summary && <p className="mt-2 break-words">{view.summary}</p>}

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

      {view.dangerNote && view.variant === "pending" && <p className="mt-2 text-xs font-semibold text-destructive">{view.dangerNote}</p>}

      {view.variant === "pending" && view.secretFields.length > 0 && (
        <div className="mt-3 space-y-2">
          {view.secretFields.map((f) => {
            const id = `${draftId}-secret-${f.name}`
            const shown = revealed[f.name] === true
            return (
              <div key={f.name}>
                <label htmlFor={id} className="text-xs font-medium text-muted-foreground">
                  {f.label}
                </label>
                <div className="mt-1 flex gap-2">
                  <input
                    id={id}
                    type={shown ? "text" : "password"}
                    autoComplete="new-password"
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                    maxLength={f.max}
                    disabled={disabled}
                    value={secrets[f.name] ?? ""}
                    onChange={(e) => {
                      const v = e.target.value
                      setSecrets((prev) => ({ ...prev, [f.name]: v }))
                    }}
                    placeholder="Type it here, not in chat"
                    className="min-w-0 flex-1 rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:opacity-50"
                  />
                  <button
                    type="button"
                    onClick={() => setRevealed((prev) => ({ ...prev, [f.name]: !shown }))}
                    aria-pressed={shown}
                    className="rounded-xl border border-border bg-card px-3 py-2 text-xs font-medium text-muted-foreground hover:bg-accent"
                  >
                    {shown ? "Hide" : "Show"}
                  </button>
                </div>
              </div>
            )
          })}
        </div>
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

      {view.pageLink && (
        <p className="mt-1">
          <Link href={view.pageLink} className="text-xs font-medium text-primary underline">
            Check the page
          </Link>
        </p>
      )}

      {loading && <p className="mt-2 text-xs text-muted-foreground">Checking this card...</p>}

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

      {view.showRetry && (
        <div className="mt-3">
          <button
            type="button"
            onClick={() => setLoadTry((n) => n + 1)}
            className="rounded-xl bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Try again
          </button>
        </div>
      )}

      {(view.showConfirm || view.showCancel || view.showCheckAgain || view.showPrepareAgain || view.topUpHref) && (
        <div className="mt-3 flex flex-wrap gap-2">
          {view.showConfirm && (
            <button
              type="button"
              disabled={confirmBlocked}
              onClick={() => act("confirm", view.secretFields, secrets)}
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
