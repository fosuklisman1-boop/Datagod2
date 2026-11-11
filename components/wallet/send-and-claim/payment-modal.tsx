"use client"

import { useState } from "react"
import { Copy, Check, X } from "lucide-react"
import { Button } from "@/components/ui/button"

export type PaymentModalData = {
  code: string
  amount: number
  number: string
  accountName: string
}

export function PaymentModal({ data, onClose }: { data: PaymentModalData; onClose: () => void }) {
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(data.code)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      /* clipboard unavailable; the code is visible to copy by hand */
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/60 p-4">
      <div role="dialog" aria-modal="true" className="w-full max-w-sm overflow-hidden rounded-2xl bg-card shadow-2xl">
        <div className="flex justify-end p-3 pb-0">
          <button onClick={onClose} aria-label="Close" className="rounded-full p-1 hover:bg-accent">
            <X className="h-5 w-5 text-muted-foreground" />
          </button>
        </div>
        <div className="space-y-4 px-6 pb-6 text-center">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Your payment code</p>
          <div className="flex items-center justify-center gap-3">
            <span className="font-mono text-4xl font-black tracking-widest text-[#1b388b] dark:text-foreground">
              {data.code}
            </span>
            <button
              onClick={copy}
              aria-label="Copy code"
              className="rounded-xl bg-[#1b388b]/10 p-2 text-[#1b388b] dark:text-foreground"
            >
              {copied ? <Check className="h-5 w-5" /> : <Copy className="h-5 w-5" />}
            </button>
          </div>
          <p className="text-sm text-foreground">
            Send exactly <b>GHS {data.amount.toFixed(2)}</b> to <b className="font-mono">{data.number}</b> ({data.accountName})
          </p>
          <p className="rounded-xl bg-[#1b388b]/10 p-3 text-sm font-medium text-foreground">
            Type <span className="font-mono font-bold">{data.code}</span> in the MoMo Reference field
          </p>
          <Button onClick={onClose} className="w-full rounded-2xl bg-[#1b388b] text-white hover:bg-[#1b388b]/90">
            I&apos;ve sent it
          </Button>
        </div>
      </div>
    </div>
  )
}
