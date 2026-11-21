"use client"

import { useState } from "react"
import { buildHandoffThreadBody, type HandoffMessage } from "@/lib/ai-chat-ui/handoff"

interface HandoffButtonProps {
  mode: "thread" | "whatsapp"
  messages: HandoffMessage[]
  /** WhatsApp support link or number (from /api/support-config or the shop). Used by guests and as the failure fallback. */
  whatsappNumber?: string | null
  /** Thread mode: returns the signed-in user's access token. */
  getToken?: () => Promise<string>
  /** Thread mode: the user's own Ghana phone number (support threads require one). Missing => WhatsApp fallback. */
  phone?: string | null
  className?: string
  children?: React.ReactNode
}

function whatsappHref(value?: string | null): string | null {
  const v = value?.trim()
  if (!v) return null
  if (/^https?:\/\//i.test(v)) return v
  const digits = v.replace(/\D/g, "")
  return digits ? `https://wa.me/${digits.startsWith("0") ? `233${digits.slice(1)}` : digits}` : null
}

export function HandoffButton({ mode, messages, whatsappNumber, getToken, phone, className, children }: HandoffButtonProps) {
  const [busy, setBusy] = useState(false)

  const openWhatsApp = () => {
    const href = whatsappHref(whatsappNumber)
    if (href) window.open(href, "_blank", "noopener,noreferrer")
  }

  const onClick = async () => {
    if (busy) return
    if (mode === "whatsapp") return openWhatsApp()
    setBusy(true)
    try {
      if (!getToken || !phone) throw new Error("no thread contact")
      const token = await getToken()
      const res = await fetch("/api/support/threads", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(buildHandoffThreadBody(messages, { phone, whatsapp: phone })),
      })
      const json = res.ok ? await res.json() : null
      const id = json?.data?.thread_id
      if (typeof id !== "string") throw new Error("thread not created")
      window.location.assign(`/dashboard/complaints?thread=${encodeURIComponent(id)}`)
    } catch {
      openWhatsApp()
    } finally {
      setBusy(false)
    }
  }

  return (
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
  )
}
