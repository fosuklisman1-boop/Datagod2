// components/developer/docs/CodeTabs.tsx
"use client"

import { useEffect, useRef, useState } from "react"
import { Check, Copy, X } from "lucide-react"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { cn } from "@/lib/utils"
import type { DocLang } from "@/lib/api-v2/docs/registry"

const LANGS: { id: DocLang; label: string; header: string }[] = [
  { id: "curl", label: "cURL", header: "Shell" },
  { id: "node", label: "Node.js", header: "JavaScript" },
  { id: "php", label: "PHP", header: "PHP" },
  { id: "python", label: "Python", header: "Python" },
]

async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // Clipboard API is unavailable on insecure origins and some webviews: fall back to a hidden textarea.
    try {
      const ta = document.createElement("textarea")
      ta.value = text
      ta.setAttribute("readonly", "")
      ta.style.position = "fixed"
      ta.style.opacity = "0"
      document.body.appendChild(ta)
      ta.select()
      const ok = document.execCommand("copy")
      document.body.removeChild(ta)
      return ok
    } catch {
      return false
    }
  }
}

/** Outlined Copy button with ~1.5s check feedback; `label` describes what is copied for screen readers. */
export function CopyButton({ text, label }: { text: string; label: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle")
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  const ariaLabel =
    state === "copied" ? `${label} copied` : state === "failed" ? `Copy failed for ${label}, select the code to copy it` : `Copy ${label}`

  return (
    <button
      type="button"
      onClick={async () => {
        const ok = await writeClipboard(text)
        setState(ok ? "copied" : "failed")
        if (timer.current) clearTimeout(timer.current)
        timer.current = setTimeout(() => setState("idle"), ok ? 1500 : 2500)
      }}
      aria-label={ariaLabel}
      className={cn(
        "inline-flex h-10 min-w-[84px] items-center justify-center gap-1.5 rounded-lg border px-3 text-xs font-semibold transition-colors hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/70",
        state === "failed" ? "border-rose-400/70 text-rose-300" : "border-slate-600/80 text-slate-200 hover:border-slate-400"
      )}
    >
      {state === "copied" ? (
        <Check className="size-3.5 text-emerald-400" aria-hidden />
      ) : state === "failed" ? (
        <X className="size-3.5" aria-hidden />
      ) : (
        <Copy className="size-3.5" aria-hidden />
      )}
      <span aria-live="polite">{state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : "Copy"}</span>
    </button>
  )
}

function PanelHeader({ title, copyText, copyLabel }: { title: string; copyText: string; copyLabel: string }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-white/10 bg-slate-900 py-1.5 pl-4 pr-1.5">
      <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-400">{title}</span>
      <CopyButton text={copyText} label={copyLabel} />
    </div>
  )
}

const PRE =
  "m-0 overflow-x-auto whitespace-pre bg-slate-950 p-4 font-mono text-[12.5px] leading-6 text-slate-100 [tab-size:2] sm:text-[13px]"
const PANEL = "overflow-hidden rounded-xl border border-slate-800 bg-slate-950 shadow-sm dark:border-white/10"

/** A single dark code panel with a header row (label + Copy). Used for JSON examples. */
export function CodeBlock({ code, title, copyLabel, className }: { code: string; title: string; copyLabel: string; className?: string }) {
  return (
    <div className={cn(PANEL, className)}>
      <PanelHeader title={title} copyText={code} copyLabel={copyLabel} />
      <pre className={PRE} tabIndex={0} aria-label={copyLabel}>
        <code>{code}</code>
      </pre>
    </div>
  )
}

/** Segmented cURL / Node.js / PHP / Python tabs over a dark code panel. Copy copies the active tab. */
export function CodeTabs({ samples, label = "code sample" }: { samples: Record<DocLang, string>; label?: string }) {
  const [lang, setLang] = useState<DocLang>("curl")
  const active = LANGS.find((l) => l.id === lang) ?? LANGS[0]

  return (
    <Tabs value={lang} onValueChange={(v) => setLang(v as DocLang)} className="gap-3">
      <TabsList
        aria-label="Code sample language"
        className="grid h-12 w-full grid-cols-4 rounded-xl border border-border/70 bg-muted p-1 sm:w-fit sm:min-w-[400px] dark:bg-black/30"
      >
        {LANGS.map((l) => (
          <TabsTrigger
            key={l.id}
            value={l.id}
            className={cn(
              "h-10 rounded-lg px-2 text-[13px] font-semibold text-muted-foreground hover:text-foreground dark:text-muted-foreground",
              "data-[state=active]:rounded-lg data-[state=active]:bg-card data-[state=active]:text-foreground data-[state=active]:shadow-md",
              "dark:data-[state=active]:border-white/10 dark:data-[state=active]:bg-slate-800 dark:data-[state=active]:text-white"
            )}
          >
            {l.label}
          </TabsTrigger>
        ))}
      </TabsList>
      <div className={PANEL}>
        <PanelHeader title={active.header} copyText={samples[lang]} copyLabel={`${active.label} ${label}`} />
        {LANGS.map((l) => (
          <TabsContent key={l.id} value={l.id} className="mt-0">
            <pre className={PRE} tabIndex={0} aria-label={`${l.label} ${label}`}>
              <code>{samples[l.id]}</code>
            </pre>
          </TabsContent>
        ))}
      </div>
    </Tabs>
  )
}
