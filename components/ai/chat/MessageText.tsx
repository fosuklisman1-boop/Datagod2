"use client"

import { useEffect, useRef, useState } from "react"
import { Check, Copy } from "lucide-react"
import { splitCopyChips } from "@/lib/ai-chat-ui/copy-chips"

function CopyChip({ value }: { value: string }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard blocked: leave the chip as is */
    }
  }

  return (
    <button
      type="button"
      onClick={copy}
      aria-label={copied ? `Copied ${value}` : `Copy ${value}`}
      className="mx-0.5 inline-flex items-center gap-1 rounded-md border border-primary/20 bg-primary/5 px-1.5 py-0.5 align-baseline font-mono text-[0.85em] text-primary transition-colors hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
    >
      <span>{value}</span>
      {copied ? <Check className="h-3 w-3" aria-hidden="true" /> : <Copy className="h-3 w-3" aria-hidden="true" />}
      <span role="status" aria-live="polite" className={copied ? "text-[10px] font-sans font-medium" : "sr-only"}>
        {copied ? "Copied" : ""}
      </span>
    </button>
  )
}

/** Plain text with order codes, USSD codes and phone numbers turned into copy chips. Other text is untouched. */
export function MessageText({ text }: { text: string }) {
  return (
    <>
      {splitCopyChips(text).map((p, i) =>
        p.kind === "chip" ? <CopyChip key={i} value={p.value} /> : <span key={i}>{p.value}</span>,
      )}
    </>
  )
}
