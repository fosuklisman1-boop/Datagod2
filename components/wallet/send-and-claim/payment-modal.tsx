"use client"

import { useEffect, useState } from "react"
import { Copy, Check, Loader2, X } from "lucide-react"
import { formatCountdownMmSs, formatPlainAmount } from "@/lib/momo-claim/view-model"
import { WINDOW_MINUTES } from "@/lib/momo-claim/window"

export type PaymentModalData = {
  sessionId: string
  code: string
  amount: number
  /** null when no MTN account is configured. */
  number: string | null
  accountName: string
  expiresAt: string
}

function useCopy() {
  const [copiedKey, setCopiedKey] = useState<string | null>(null)
  const copy = async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopiedKey(key)
      setTimeout(() => setCopiedKey((k) => (k === key ? null : k)), 2000)
    } catch {
      /* clipboard unavailable; the value is visible to copy by hand */
    }
  }
  return { copiedKey, copy }
}

function CopyButton({ copied, onClick, label }: { copied: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-sm font-medium text-foreground hover:bg-accent"
    >
      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      {copied ? "Copied" : "Copy"}
    </button>
  )
}

export function PaymentModal({ data, onClose }: { data: PaymentModalData; onClose: () => void }) {
  const { copiedKey, copy } = useCopy()
  const [nowMs, setNowMs] = useState(() => Date.now())

  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  const amountText = formatPlainAmount(data.amount)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Payment details"
        className="max-h-[95vh] w-full max-w-md overflow-y-auto rounded-2xl bg-card p-6 shadow-2xl"
      >
        <div className="flex items-start justify-between">
          <h2 className="text-lg font-bold text-foreground">Payment details</h2>
          <button onClick={onClose} aria-label="Close" className="rounded-full p-1 hover:bg-accent">
            <X className="h-5 w-5 text-muted-foreground" />
          </button>
        </div>

        <div className="mt-4 rounded-xl border border-amber-300 bg-amber-50 p-4 text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200">
          <p className="text-sm font-bold uppercase">IMPORTANT — USE YOUR REFERENCE</p>
          <p className="mt-1 text-base">
            Type the reference below in the <b>reference / narration</b> box when you send the money. Without it we can&apos;t
            credit your wallet automatically.
          </p>
        </div>

        <div className="mt-4 rounded-xl border-2 border-[#1b388b] bg-[#1b388b]/5 p-4 text-center dark:border-[#7f9bf0] dark:bg-[#1b388b]/20">
          <p className="text-sm font-medium uppercase text-muted-foreground">Your reference</p>
          <p className="mt-2 font-mono text-3xl font-black tracking-[0.2em] text-foreground">{data.code}</p>
          <button
            type="button"
            onClick={() => copy("code", data.code)}
            className="mt-3 inline-flex items-center gap-2 rounded-xl border border-border bg-card px-4 py-2 text-sm font-medium text-foreground hover:bg-accent"
          >
            {copiedKey === "code" ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            {copiedKey === "code" ? "Copied" : "Copy reference"}
          </button>
        </div>

        <div className="mt-4 divide-y divide-border rounded-xl border border-border">
          <div className="flex items-center justify-between gap-3 p-4">
            <span className="text-sm text-muted-foreground">Account name</span>
            <span className="flex items-center gap-3">
              <span className="text-right font-bold text-foreground">{data.accountName}</span>
              <CopyButton copied={copiedKey === "name"} onClick={() => copy("name", data.accountName)} label="Copy account name" />
            </span>
          </div>
          <div className="flex items-center justify-between gap-3 p-4">
            <span className="text-sm text-muted-foreground">MoMo number · MTN</span>
            {data.number ? (
              <span className="flex items-center gap-3">
                <span className="font-mono font-bold text-foreground">{data.number}</span>
                <CopyButton copied={copiedKey === "number"} onClick={() => copy("number", data.number as string)} label="Copy MoMo number" />
              </span>
            ) : (
              <span className="text-right text-sm text-destructive">Payment number not set — contact support</span>
            )}
          </div>
          <div className="flex items-center justify-between gap-3 p-4">
            <span className="text-sm text-muted-foreground">Amount</span>
            <span className="flex items-center gap-3">
              <span className="text-xl font-bold text-foreground">GH₵{amountText}</span>
              <CopyButton copied={copiedKey === "amount"} onClick={() => copy("amount", amountText)} label="Copy amount" />
            </span>
          </div>
        </div>

        <div className="mt-4 text-center">
          <p className="flex items-center justify-center gap-2 text-foreground">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            Waiting for your payment…
          </p>
          <p className="mt-1 font-mono text-xs text-muted-foreground">Expires in {formatCountdownMmSs(data.expiresAt, nowMs)}</p>
        </div>

        <p className="mt-4 text-center text-sm text-muted-foreground">
          Payment details stay valid for {WINDOW_MINUTES} minutes. If you close this window, they stay active. Sent without the
          reference? Close this window and use the <b className="text-foreground">Sent money but not credited?</b> box on the page.
        </p>

        <button type="button" onClick={onClose} className="mt-3 w-full py-2 text-sm text-foreground hover:underline">
          Close
        </button>
      </div>
    </div>
  )
}
