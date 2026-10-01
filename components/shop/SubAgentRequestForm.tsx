"use client"

import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import TurnstileWidget from "@/components/shop/TurnstileWidget"
import HoneypotField from "@/components/shop/HoneypotField"
import { Loader2, CheckCircle2, UserPlus } from "lucide-react"
import { toast } from "sonner"

interface SubAgentRequestFormProps {
  shopSlug: string
}

export function SubAgentRequestForm({ shopSlug }: SubAgentRequestFormProps) {
  const [name, setName] = useState("")
  const [phone, setPhone] = useState("")
  const [email, setEmail] = useState("")
  const [message, setMessage] = useState("")
  const [honeypot, setHoneypot] = useState("")
  const [turnstileToken, setTurnstileToken] = useState("")
  const [turnstileEnabled, setTurnstileEnabled] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)

  useEffect(() => {
    fetch("/api/public/turnstile-status")
      .then(r => r.ok ? r.json() : { enabled: true })
      .then(d => setTurnstileEnabled(d.enabled !== false))
      .catch(() => setTurnstileEnabled(true))
  }, [])

  async function submit() {
    if (!name.trim() || !phone.trim()) {
      toast.error("Name and phone number are required.")
      return
    }
    setSubmitting(true)
    try {
      const res = await fetch("/api/shop/sub-agent-requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shopSlug,
          requesterName: name.trim(),
          requesterPhone: phone.trim(),
          requesterEmail: email.trim() || undefined,
          message: message.trim() || undefined,
          turnstileToken,
          website: honeypot,
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        toast.error(data.error ?? "Could not submit your request.")
        return
      }
      setSubmitted(true)
    } catch {
      toast.error("Network error. Please try again.")
    } finally {
      setSubmitting(false)
    }
  }

  if (submitted) {
    return (
      <div className="flex flex-col items-center gap-2 py-6 text-center">
        <CheckCircle2 className="h-8 w-8 text-[var(--shop-accent)]" />
        <p className="font-semibold text-foreground">Request sent!</p>
        <p className="text-sm text-muted-foreground">The shop owner will review it and reach out to you by phone or email if approved.</p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <span className="grid h-9 w-9 place-items-center rounded-xl bg-[var(--shop-accent)]/10 text-[var(--shop-accent)]">
          <UserPlus className="h-4 w-4" />
        </span>
        <div>
          <p className="font-semibold text-foreground">Want to start your own shop?</p>
          <p className="text-xs text-muted-foreground">Ask to become a sub-agent under this shop.</p>
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="sar-name">Your name</Label>
        <Input id="sar-name" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Kwame Mensah" maxLength={100} />
      </div>
      <div className="space-y-2">
        <Label htmlFor="sar-phone">Phone number</Label>
        <Input id="sar-phone" value={phone} onChange={e => setPhone(e.target.value)} placeholder="e.g. 0244123456" maxLength={15} />
      </div>
      <div className="space-y-2">
        <Label htmlFor="sar-email">Email (optional)</Label>
        <Input id="sar-email" type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@example.com" maxLength={200} />
      </div>
      <div className="space-y-2">
        <Label htmlFor="sar-message">Message (optional)</Label>
        <Textarea id="sar-message" value={message} onChange={e => setMessage(e.target.value)} placeholder="Tell them why you'd like to sell under this shop" maxLength={500} rows={3} />
      </div>

      <HoneypotField value={honeypot} onChange={setHoneypot} />

      {turnstileEnabled && (
        <TurnstileWidget onToken={setTurnstileToken} onExpire={() => setTurnstileToken("")} />
      )}

      <Button
        onClick={submit}
        disabled={submitting || !name.trim() || !phone.trim() || (turnstileEnabled && !turnstileToken)}
        className="w-full text-white"
        style={{ backgroundColor: "var(--shop-accent)" }}
      >
        {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : "Send request"}
      </Button>
    </div>
  )
}
