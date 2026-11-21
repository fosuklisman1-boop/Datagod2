"use client"

import { createContext, useContext, useEffect, useRef, useState } from "react"
import { Check, Copy } from "lucide-react"
import { splitCopyChips } from "@/lib/ai-chat-ui/copy-chips"

type Announce = (() => void) | null
const AnnounceContext = createContext<Announce>(null)

function useAnnouncer() {
  const [text, setText] = useState("")
  const t = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (t.current) clearTimeout(t.current) }, [])
  const announce = () => {
    setText("Copied")
    if (t.current) clearTimeout(t.current)
    t.current = setTimeout(() => setText(""), 1500)
  }
  return { text, announce }
}

/** Wrap one whole message (e.g. its markdown) so all its copy chips share a single polite live region. */
export function CopyAnnounceProvider({ children }: { children: React.ReactNode }) {
  const { text, announce } = useAnnouncer()
  return (
    <AnnounceContext.Provider value={announce}>
      {children}
      <span role="status" aria-live="polite" className="sr-only">{text}</span>
    </AnnounceContext.Provider>
  )
}

function CopyChip({ value, onCopied }: { value: string; onCopied: () => void }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      onCopied()
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
    </button>
  )
}

function Chips({ text, onCopied }: { text: string; onCopied: () => void }) {
  return (
    <>
      {splitCopyChips(text).map((p, i) =>
        p.kind === "chip" ? <CopyChip key={i} value={p.value} onCopied={onCopied} /> : <span key={i}>{p.value}</span>,
      )}
    </>
  )
}

function Standalone({ text }: { text: string }) {
  const { text: live, announce } = useAnnouncer()
  return (
    <>
      <Chips text={text} onCopied={announce} />
      <span role="status" aria-live="polite" className="sr-only">{live}</span>
    </>
  )
}

/** Plain text with order codes, USSD codes and phone numbers as copy chips. Inside a CopyAnnounceProvider it adds no live region of its own. */
export function MessageText({ text }: { text: string }) {
  const shared = useContext(AnnounceContext)
  return shared ? <Chips text={text} onCopied={shared} /> : <Standalone text={text} />
}
