"use client"

import { useState } from "react"
import { buildHandoffThreadBody, handoffAvailable, handoffFailureMessage, whatsappHref, type HandoffMessage } from "@/lib/ai-chat-ui/handoff"

interface HandoffButtonProps {
  mode: "thread" | "whatsapp"
  messages: HandoffMessage[]
  /** WhatsApp support link or number (from /api/support-config or the shop). Used by guests and as the failure fallback. */
  whatsappNumber?: string | null
  /** Thread mode: returns the signed-in user's access token. */
  getToken?: () => Promise<string>
  /** Thread mode: the user's own Ghana phone number (support threads require one). Missing => WhatsApp fallback. */
  phone?: string | null
  /** Called with how the press ended. */
  onOutcome?: (kind: "thread" | "whatsapp" | "fallback") => void
  className?: string
  children?: React.ReactNode
}

export function HandoffButton({ mode, messages, whatsappNumber, getToken, phone, onOutcome, className, children }: HandoffButtonProps) {
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState("")

  const openWhatsApp = () => {
    const href = whatsappHref(whatsappNumber)
    if (href) window.open(href, "_blank", "noopener,noreferrer")
  }

  const hasToken = !!getToken
  const onClick = async () => {
    if (busy) return
    if (mode === "whatsapp") {
      openWhatsApp()
      onOutcome?.("whatsapp")
      return
    }
    setBusy(true)
    setNotice("")
    let status: number | undefined
    try {
      if (!getToken || !phone) throw new Error("no thread contact")
      const token = await getToken()
      const res = await fetch("/api/support/threads", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(buildHandoffThreadBody(messages, { phone, whatsapp: phone })),
      })
      status = res.status
      const json = res.ok ? await res.json() : null
      const id = json?.data?.thread_id
      if (typeof id !== "string") throw new Error("thread not created")
      onOutcome?.("thread")
      window.location.assign(`/dashboard/complaints?thread=${encodeURIComponent(id)}`)
    } catch {
      setNotice(handoffFailureMessage(status))
      onOutcome?.("fallback")
      openWhatsApp()
    } finally {
      setBusy(false)
    }
  }

  if (!handoffAvailable({ mode, hasToken, phone, whatsapp: whatsappNumber })) return null

  return (
    <>
      <button
        type="button"
        onClick={onClick}
        disabled={busy}
        className={
          className ??
          "text-xs font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50"
        }
      >
        {busy ? "Opening…" : (children ?? "Talk to a person")}
      </button>
      {mode === "thread" && (
        <span role="status" aria-live="polite" className={notice ? "block text-xs text-muted-foreground" : "sr-only"}>
          {notice}
        </span>
      )}
    </>
  )
}
