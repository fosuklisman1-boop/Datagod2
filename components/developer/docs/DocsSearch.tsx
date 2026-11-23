// components/developer/docs/DocsSearch.tsx
"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import Link from "next/link"
import { Search } from "lucide-react"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import { searchDocs, shouldHijackSlash, type SearchEntry } from "@/lib/api-v2/docs/search-index"

const INDEX_URL = "/developers/search-index.json"

// One fetch per page load, shared by every instance. A failure is not cached so the next open retries.
let indexPromise: Promise<SearchEntry[]> | null = null
function loadIndex(): Promise<SearchEntry[]> {
  if (!indexPromise) {
    indexPromise = fetch(INDEX_URL)
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status))
        return r.json() as Promise<SearchEntry[]>
      })
      .catch((err) => {
        indexPromise = null
        throw err
      })
  }
  return indexPromise
}

const KIND_LABEL: Record<SearchEntry["kind"], string> = { page: "Page", section: "Section", endpoint: "Endpoint", error: "Error" }

/** Search button plus a results dialog. Opens on click or "/" (when this instance's button is on screen). */
export function DocsSearch({ className }: { className?: string }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [index, setIndex] = useState<SearchEntry[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [cursor, setCursor] = useState(0)
  const trigger = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Two instances exist (header and phone bar); only the one whose button is displayed reacts.
      if (!trigger.current || trigger.current.offsetParent === null) return
      if (!shouldHijackSlash({ key: e.key, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, target: e.target as HTMLElement | null })) return
      e.preventDefault()
      setOpen(true)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  useEffect(() => {
    if (!open || index) return
    let live = true
    setFailed(false)
    loadIndex().then(
      (data) => live && setIndex(data),
      () => live && setFailed(true)
    )
    return () => {
      live = false
    }
  }, [open, index])

  const results = useMemo(() => (index ? searchDocs(index, query) : []), [index, query])

  const close = () => {
    setOpen(false)
    setQuery("")
    setCursor(0)
  }

  const onInputKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" && results.length > 0) {
      e.preventDefault()
      setCursor((c) => (c + 1) % results.length)
    } else if (e.key === "ArrowUp" && results.length > 0) {
      e.preventDefault()
      setCursor((c) => (c - 1 + results.length) % results.length)
    } else if (e.key === "Enter" && results[cursor]) {
      e.preventDefault()
      // Follow the highlighted result link, so Enter and a click go the same way (and close the dialog).
      document.getElementById(`docs-search-${cursor}`)?.querySelector("a")?.click()
    }
  }

  return (
    <>
      <button
        ref={trigger}
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Search the docs"
        aria-haspopup="dialog"
        className={cn(
          "inline-flex h-10 w-full min-w-0 items-center gap-2 rounded-xl border border-border bg-muted/60 px-3 text-sm text-muted-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          className
        )}
      >
        <Search className="size-4 shrink-0" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-left">Search docs</span>
        <kbd className="hidden rounded border border-border bg-card px-1.5 font-mono text-xs sm:inline">/</kbd>
      </button>

      <Dialog open={open} onOpenChange={(o) => (o ? setOpen(true) : close())}>
        <DialogContent showCloseButton={false} className="top-[15%] max-w-[calc(100%-2rem)] translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-xl">
          <DialogTitle className="sr-only">Search the developer docs</DialogTitle>
          <DialogDescription className="sr-only">Type to find pages, sections, endpoints and errors. Use the arrow keys and Enter to open one.</DialogDescription>
          <div className="flex items-center gap-2 border-b border-border px-4">
            <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <input
              autoFocus
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
                setCursor(0)
              }}
              onKeyDown={onInputKey}
              role="combobox"
              aria-expanded={results.length > 0}
              aria-controls="docs-search-results"
              aria-activedescendant={results[cursor] ? `docs-search-${cursor}` : undefined}
              aria-label="Search the docs"
              placeholder="Search endpoints, errors, pages"
              autoComplete="off"
              spellCheck={false}
              className="h-12 min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground"
            />
          </div>
          <div className="max-h-[60vh] overflow-y-auto p-2">
            {failed ? (
              <p className="px-3 py-6 text-center text-sm text-muted-foreground">Search could not load. Close this and try again.</p>
            ) : !index ? (
              <p className="px-3 py-6 text-center text-sm text-muted-foreground">Loading search</p>
            ) : query.trim() === "" ? (
              <p className="px-3 py-6 text-center text-sm text-muted-foreground">Type to search the docs.</p>
            ) : results.length === 0 ? (
              <p className="px-3 py-6 text-center text-sm text-muted-foreground">No results for &ldquo;{query.trim()}&rdquo;.</p>
            ) : (
              <ul id="docs-search-results" role="listbox" aria-label="Results">
                {results.map((r, i) => (
                  <li key={`${r.href}-${i}`} role="option" id={`docs-search-${i}`} aria-selected={i === cursor}>
                    <Link
                      href={r.href}
                      onClick={close}
                      onMouseMove={() => setCursor(i)}
                      className={cn("block rounded-lg px-3 py-2.5", i === cursor ? "bg-primary/10" : "hover:bg-muted")}
                    >
                      <span className="flex items-center gap-2">
                        <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-primary">
                          {KIND_LABEL[r.kind]}
                        </span>
                        <span className="min-w-0 break-all text-sm font-semibold text-foreground">{r.title}</span>
                      </span>
                      {r.detail && <span className="mt-1 line-clamp-2 block text-xs leading-5 text-muted-foreground">{r.detail}</span>}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
