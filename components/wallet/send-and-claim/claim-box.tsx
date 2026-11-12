"use client"

import { useState } from "react"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

export type ClaimSession = {
  id: string
  code: string
  amount: number
  netAmount: number
  expiresAt: string
}

export function formatCountdown(targetIso: string | Date, nowMs: number): string {
  const ms = new Date(targetIso).getTime() - nowMs
  if (ms <= 0) return "0:00"
  const s = Math.floor(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
}

type Props = {
  session: ClaimSession
  nowMs: number
  getToken: () => Promise<string | null>
  onDone: () => void
  onCancel: (id: string) => void
}

export function ClaimBox({ session, nowMs, getToken, onDone, onCancel }: Props) {
  const [txId, setTxId] = useState("")
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const submit = async () => {
    setBusy(true)
    setMessage(null)
    try {
      const token = await getToken()
      const res = await fetch("/api/wallet/momo-claim", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ transactionId: txId.trim(), sessionId: session.id }),
      })
      const body = await res.json().catch(() => ({}))
      setMessage(typeof body.message === "string" ? body.message : "Something went wrong. Please try again.")
      onDone()
    } catch {
      setMessage("Something went wrong. Please try again.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3 rounded-2xl border border-border bg-card p-4 shadow-sm">
      <p className="text-sm font-bold text-foreground">Sent money but not credited?</p>
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="font-mono text-lg font-black tracking-widest text-[#1b388b] dark:text-foreground">{session.code}</p>
          <p className="text-xs text-muted-foreground">
            Send GHS {session.amount.toFixed(2)} · You get GHS {session.netAmount.toFixed(2)}
          </p>
        </div>
        <span className="rounded-full bg-warning/15 px-2 py-1 text-xs font-semibold tabular-nums text-warning">
          {formatCountdown(session.expiresAt, nowMs)} left
        </span>
      </div>
      <Input
        value={txId}
        onChange={(e) => setTxId(e.target.value)}
        placeholder="MoMo Transaction ID"
        aria-label="MoMo Transaction ID"
        className="rounded-xl"
      />
      <p className="text-xs text-muted-foreground">Enter the transaction ID from your MoMo confirmation SMS.</p>
      {message && <p className="rounded-xl bg-muted p-3 text-sm text-foreground">{message}</p>}
      <div className="flex gap-2">
        <Button
          onClick={submit}
          disabled={busy || txId.trim().length === 0}
          className="flex-1 rounded-2xl bg-[#1b388b] text-white hover:bg-[#1b388b]/90"
        >
          {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Claim GHS {session.netAmount.toFixed(2)}
        </Button>
        <Button variant="outline" onClick={() => onCancel(session.id)} className="rounded-2xl">
          Cancel
        </Button>
      </div>
    </div>
  )
}
