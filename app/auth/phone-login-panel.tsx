"use client"

import { useEffect, useReducer, useState, type ReactNode } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import Link from "next/link"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { supabase } from "@/lib/supabase"
import { Eye, EyeOff, Lock, Phone, ShieldCheck } from "lucide-react"
import {
  GENERIC_ERROR,
  eventFromResendResponse,
  eventFromStartResponse,
  eventFromVerifyResponse,
  initialPanelState,
  panelReducer,
  type PanelEvent,
} from "@/lib/phone-login/panel-state"

type Tab = "email" | "phone"

async function postJson(url: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(body),
  })
  let parsed: unknown = null
  try {
    parsed = await res.json()
  } catch {
    parsed = null
  }
  return { status: res.status, body: parsed }
}

/**
 * Email | Phone tabs for the login card. `children` is the existing email form,
 * rendered untouched on the Email tab. The Phone tab only appears when the
 * server says phone sign-in is enabled; if that check fails the tab stays hidden.
 */
export default function PhoneLoginTabs({ redirectTo, children }: { redirectTo: string; children: ReactNode }) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [state, dispatch] = useReducer(panelReducer, undefined, initialPanelState)
  const [tab, setTab] = useState<Tab>("email")
  const [showPassword, setShowPassword] = useState(false)

  // Availability. A non-production preview flag lets screenshots render without a backend.
  useEffect(() => {
    if (process.env.NODE_ENV !== "production" && searchParams.get("phoneLoginPreview") === "1") {
      dispatch({ type: "availability", enabled: true })
      return
    }
    let cancelled = false
    fetch("/api/auth/phone-login", { credentials: "same-origin" })
      .then(async (res) => {
        const body = res.ok ? await res.json() : null
        if (!cancelled) dispatch({ type: "availability", enabled: body?.enabled === true })
      })
      .catch(() => {
        if (!cancelled) dispatch({ type: "availability", enabled: null })
      })
    return () => {
      cancelled = true
    }
  }, [searchParams])

  // Toast each new message once.
  useEffect(() => {
    if (state.message) toast.error(state.message)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.noticeId])

  // Step 1 unavailable: move to the Email tab and focus it.
  useEffect(() => {
    if (!state.focusEmail) return
    setTab("email")
    const t = setTimeout(() => document.getElementById("email")?.focus(), 0)
    return () => clearTimeout(t)
  }, [state.focusEmail])

  // Resend countdown.
  useEffect(() => {
    if (state.phase !== "code" || state.resendSeconds <= 0) return
    const t = setTimeout(() => dispatch({ type: "tick" }), 1000)
    return () => clearTimeout(t)
  }, [state.phase, state.resendSeconds])

  // Signed in: install the session, then navigate.
  useEffect(() => {
    if (state.phase !== "signedIn" || !state.session) return
    const s = state.session as { access_token?: string; refresh_token?: string }
    const fail = () => {
      dispatch({ type: "failed", message: GENERIC_ERROR })
      dispatch({ type: "back" })
    }
    if (!s.access_token || !s.refresh_token) {
      fail()
      return
    }
    ;(async () => {
      try {
        const { error } = await supabase.auth.setSession({
          access_token: s.access_token as string,
          refresh_token: s.refresh_token as string,
        })
        if (error) throw error
        toast.success("Login successful!")
        router.push(redirectTo)
      } catch {
        fail()
      }
    })()
  }, [state.phase, state.session, redirectTo, router])

  async function call(
    request: () => Promise<{ status: number; body: unknown }>,
    map: (status: number, body: unknown) => PanelEvent,
  ) {
    dispatch({ type: "submitting" })
    try {
      const r = await request()
      dispatch(map(r.status, r.body))
    } catch {
      dispatch({ type: "network_error" })
    }
  }

  const submitStart = (e: React.FormEvent) => {
    e.preventDefault()
    if (!state.phone.trim() || !state.password) {
      toast.error("Please fill in all fields")
      return
    }
    void call(() => postJson("/api/auth/phone-login", { phone: state.phone, password: state.password }), eventFromStartResponse)
  }

  const submitCode = (e: React.FormEvent) => {
    e.preventDefault()
    if (!state.challenge) return
    if (state.code.length !== 6) {
      toast.error("Enter the 6-digit code")
      return
    }
    const challengeId = state.challenge.id
    void call(() => postJson("/api/auth/phone-login/verify", { challengeId, code: state.code }), eventFromVerifyResponse)
  }

  const resend = () => {
    if (!state.challenge || state.resendSeconds > 0 || state.busy) return
    const challengeId = state.challenge.id
    void call(() => postJson("/api/auth/phone-login/resend", { challengeId }), eventFromResendResponse)
  }

  const tabClass = (t: Tab) =>
    `flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
      tab === t ? "bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
    }`

  return (
    <div>
      {state.visible && (
        <div role="tablist" aria-label="Sign in method" className="mb-4 flex gap-1 rounded-lg bg-muted p-1">
          <button type="button" role="tab" aria-selected={tab === "email"} className={tabClass("email")} onClick={() => setTab("email")}>
            Email
          </button>
          <button type="button" role="tab" aria-selected={tab === "phone"} className={tabClass("phone")} onClick={() => setTab("phone")}>
            Phone
          </button>
        </div>
      )}

      {tab === "email" || !state.visible ? (
        children
      ) : state.phase === "code" && state.challenge ? (
        <form onSubmit={submitCode} className="space-y-4">
          <div className="flex items-start gap-3 rounded-lg border border-border bg-card p-3">
            <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
            <p className="text-sm text-foreground">
              We sent a code to <span className="font-semibold">{state.challenge.maskedPhone}</span>
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="phone-code">6-digit code</Label>
            <Input
              id="phone-code"
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              placeholder="123456"
              value={state.code}
              onChange={(e) => dispatch({ type: "edit", field: "code", value: e.target.value })}
              className="text-center text-lg tracking-[0.5em]"
              autoFocus
            />
            {state.attemptsLeft !== null && (
              <p className="text-xs text-muted-foreground">
                {state.attemptsLeft} {state.attemptsLeft === 1 ? "attempt" : "attempts"} left
              </p>
            )}
          </div>
          <Button type="submit" className="w-full font-semibold" disabled={state.busy}>
            {state.busy ? "Verifying..." : "Verify"}
          </Button>
          <div className="flex items-center justify-between text-sm">
            <button
              type="button"
              onClick={resend}
              disabled={state.resendSeconds > 0 || state.busy}
              className="font-medium text-primary hover:underline disabled:cursor-not-allowed disabled:text-muted-foreground disabled:no-underline"
            >
              {state.resendSeconds > 0 ? `Resend code in ${state.resendSeconds}s` : "Resend code"}
            </button>
            <button type="button" onClick={() => dispatch({ type: "back" })} className="text-muted-foreground hover:text-foreground hover:underline">
              Use a different number
            </button>
          </div>
        </form>
      ) : (
        <form onSubmit={submitStart} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="phone">Phone number</Label>
            <div className="relative">
              <Phone className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                id="phone"
                name="phone"
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                placeholder="024 123 4567"
                value={state.phone}
                onChange={(e) => dispatch({ type: "edit", field: "phone", value: e.target.value })}
                required
                className="pl-9"
              />
            </div>
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="phone-password">Password</Label>
              <Link href="/auth/forgot-password" className="text-xs font-medium text-primary hover:underline">
                Forgot password?
              </Link>
            </div>
            <div className="relative">
              <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                id="phone-password"
                name="password"
                type={showPassword ? "text" : "password"}
                autoComplete="current-password"
                placeholder="••••••••"
                value={state.password}
                onChange={(e) => dispatch({ type: "edit", field: "password", value: e.target.value })}
                required
                className="pl-9 pr-10"
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                aria-label={showPassword ? "Hide password" : "Show password"}
              >
                {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>
          <Button type="submit" className="w-full font-semibold" disabled={state.busy}>
            {state.busy ? "Signing in..." : "Sign in"}
          </Button>
        </form>
      )}
    </div>
  )
}
