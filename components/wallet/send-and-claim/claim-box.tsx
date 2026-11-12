"use client"

import { useState } from "react"
import { CircleAlert, Loader2 } from "lucide-react"
import { Input } from "@/components/ui/input"
import {
  claimHelpLine,
  formatCountdownMmSs,
  formatPlainAmount,
  formatStartedAt,
  isValidTransactionId,
} from "@/lib/momo-claim/view-model"

export type ClaimSession = {
  id: string
  code: string
  amount: number
  netAmount: number
  createdAt: string
  expiresAt: string
}

type Props = {
  session: ClaimSession
  limits: { minNet: number; maxSent: number }
  nowMs: number
  getToken: () => Promise<string | null>
  onDone: () => void
  onShowDetails: (id: string) => void
  onCancel: (id: string) => void
}

export function ClaimBox({ session, limits, nowMs, getToken, onDone, onShowDetails, onCancel }: Props) {
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
    <div className="space-y-4 rounded-2xl border border-amber-300 bg-card p-5 shadow-sm dark:border-amber-500/40">
      <div className="flex items-center justify-between gap-2">
        <p className="flex items-center gap-2 font-bold text-foreground">
          <CircleAlert className="h-5 w-5 flex-shrink-0 text-amber-600 dark:text-amber-400" />
          Sent money but not credited?
        </p>
        <span className="font-mono text-xs font-bold tabular-nums text-foreground">
          {formatCountdownMmSs(session.expiresAt, nowMs)}
        </span>
      </div>
      <p className="text-sm text-muted-foreground">
        Payment started {formatStartedAt(session.createdAt)}. This box closes when you&apos;re credited or the time runs out.
      </p>

      <div className="space-y-2">
        <label htmlFor={`claim-amount-${session.id}`} className="block text-base font-bold text-foreground">
          Amount sent (GHS)
        </label>
        <Input
          id={`claim-amount-${session.id}`}
          value={formatPlainAmount(session.amount)}
          readOnly
          disabled
          className="h-12 rounded-xl bg-muted text-lg"
        />
        <p className="text-xs text-muted-foreground">{claimHelpLine(limits)}</p>
      </div>

      <div className="space-y-2">
        <label htmlFor={`claim-tx-${session.id}`} className="block text-base font-bold text-foreground">
          Transaction ID
        </label>
        <div className="flex gap-2">
          <Input
            id={`claim-tx-${session.id}`}
            value={txId}
            onChange={(e) => setTxId(e.target.value)}
            placeholder="From your MoMo confirmation SMS"
            inputMode="numeric"
            className="h-11 flex-1 rounded-xl font-mono"
          />
          <button
            type="button"
            onClick={submit}
            disabled={busy || !isValidTransactionId(txId)}
            className="inline-flex h-11 items-center justify-center rounded-xl bg-[#1b388b] px-5 font-semibold text-white shadow-md hover:bg-[#1b388b]/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Check
          </button>
        </div>
        {message && <p className="rounded-xl bg-muted p-3 text-sm text-foreground">{message}</p>}
      </div>

      <div className="flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={() => onShowDetails(session.id)}
          className="text-sm font-medium text-[#1b388b] hover:underline dark:text-[#9db4f5]"
        >
          Show my payment details again
        </button>
        <button type="button" onClick={() => onCancel(session.id)} className="text-xs text-muted-foreground hover:underline">
          Cancel this payment
        </button>
      </div>
    </div>
  )
}
