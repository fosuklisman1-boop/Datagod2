"use client"

import { useState } from "react"
import { ChevronDown } from "lucide-react"

const STEPS = [
  "Enter the amount you want to send and tap Get payment code.",
  "Send that exact amount by MTN MoMo to the number shown.",
  "Type your payment code in the MoMo Reference field.",
  "Your wallet is credited automatically. Forgot the code? Paste your MoMo Transaction ID in the claim box.",
]

export function HowItWorks({ defaultOpen }: { defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="rounded-2xl border border-white/60 dark:border-white/5 bg-card clay">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center justify-between p-4 text-sm font-bold text-foreground"
      >
        How Send &amp; Claim works
        <ChevronDown className={`h-4 w-4 text-[#1b388b] transition ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <ol className="space-y-2 px-4 pb-4">
          {STEPS.map((s, i) => (
            <li key={s} className="flex gap-3 text-sm text-muted-foreground">
              <span className="grid h-6 w-6 flex-shrink-0 place-items-center rounded-full bg-[#1b388b]/10 text-xs font-bold text-[#1b388b]">
                {i + 1}
              </span>
              {s}
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}
