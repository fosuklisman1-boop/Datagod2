"use client"

import { useEffect, useRef, useState } from "react"
import { Check, Sparkles } from "lucide-react"
import { cn } from "@/lib/utils"
import { copyApiMarkdown } from "@/lib/api-v2/docs/copy-for-ai"
import { writeClipboard } from "./CodeTabs"

/** Copies the whole API as Markdown (/developers/api.md) so it can be pasted into an AI assistant. Never throws. */
export function CopyForAi({ className }: { className?: string }) {
  const [state, setState] = useState<"idle" | "busy" | "copied" | "failed">("idle")
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  return (
    <span className={cn("inline-flex flex-col gap-1", className)}>
      <button
        type="button"
        disabled={state === "busy"}
        onClick={async () => {
          setState("busy")
          const ok = await copyApiMarkdown((u) => fetch(u), writeClipboard)
          setState(ok ? "copied" : "failed")
          if (timer.current) clearTimeout(timer.current)
          timer.current = setTimeout(() => setState("idle"), ok ? 2000 : 4000)
        }}
        className="inline-flex min-h-10 items-center justify-center gap-2 whitespace-nowrap rounded-xl border border-border bg-card px-4 text-sm font-semibold text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-60"
      >
        {state === "copied" ? <Check className="size-4 text-emerald-600" aria-hidden /> : <Sparkles className="size-4" aria-hidden />}
        <span aria-live="polite">{state === "copied" ? "Copied" : state === "busy" ? "Copying..." : "Copy for AI"}</span>
      </button>
      {state === "failed" && (
        <span role="alert" className="text-xs text-destructive">
          Could not copy. Open <a href="/developers/api.md" className="underline">/developers/api.md</a> and copy it by hand.
        </span>
      )}
    </span>
  )
}
