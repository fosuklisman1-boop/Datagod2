"use client"

import { useEffect, useState, type ReactNode } from "react"
import { ChevronDown, CircleHelp } from "lucide-react"
import { formatGhs } from "@/lib/momo-claim/view-model"
import { WINDOW_MINUTES } from "@/lib/momo-claim/window"

const STEPS: ReactNode[] = [
  <>Type the amount you want to add below and tap <b>Generate Payment Details</b>.</>,
  <>We show a MoMo number and a short <b>reference code</b>. Open your MoMo menu or app and choose <b>Send Money</b>.</>,
  <>Enter our number and the <b>exact amount</b>, then type the reference code in the <b>reference / narration</b> box.</>,
  <>Confirm with your PIN. Your wallet is credited automatically within moments.</>,
  <>Not credited? Close the payment window and use the <b>Sent money but not credited?</b> box on this page. Enter the transaction ID from your MoMo confirmation SMS.</>,
]

type Props = {
  defaultOpen: boolean
  limits: { minNet: number; maxSent: number }
  /** Increment to force the guide open (e.g. from the "Show me how" link). */
  openSignal?: number
}

export function HowItWorks({ defaultOpen, limits, openSignal = 0 }: Props) {
  const [open, setOpen] = useState(defaultOpen)
  useEffect(() => {
    if (openSignal > 0) setOpen(true)
  }, [openSignal])
  return (
    <div className="rounded-2xl border border-border bg-card shadow-sm">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 p-4 text-sm font-bold text-foreground"
      >
        <span className="flex items-center gap-2">
          <CircleHelp className="h-4 w-4 text-[#1b388b] dark:text-primary" />
          How Send &amp; Claim works
        </span>
        <ChevronDown className={`h-4 w-4 text-muted-foreground transition ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div className="space-y-3 px-4 pb-4 text-sm text-foreground">
          <p>Fund your wallet by sending Mobile Money to us. It takes about a minute.</p>
          <ol className="list-decimal space-y-2 pl-5 marker:text-foreground">
            {STEPS.map((s, i) => (
              <li key={i} className="pl-1">{s}</li>
            ))}
          </ol>
          <div className="space-y-1.5 rounded-xl bg-muted p-3">
            <p>
              <b>Before you send:</b> send exactly the amount shown, to the number shown, with the reference code.
            </p>
            <p>
              Your payment details stay valid for <b>{WINDOW_MINUTES} minutes</b>. If that passes, generate new details. If
              you already sent money, contact support with your transaction ID.
            </p>
            <p>
              Send between <b>{formatGhs(limits.minNet, { fixed: true })}</b> and <b>{formatGhs(limits.maxSent)}</b>.
            </p>
          </div>
        </div>
      )}
    </div>
  )
}
