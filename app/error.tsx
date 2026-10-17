"use client"
import { useEffect } from "react"
import { Button } from "@/components/ui/button"

// After a deploy, a page that was already open (or a home-screen app resumed from the background) can try to
// load code files from the previous build, which no longer exist. That surfaces here as a chunk-load error,
// not a real bug: reload once to pick up the new build instead of stranding the user on this screen.
const RELOAD_KEY = "datagod:chunk-reload-at"
const isChunkError = (e: Error) =>
  /ChunkLoadError|Loading chunk [\w-]+ failed|Loading CSS chunk|Failed to fetch dynamically imported module|Importing a module script failed/i
    .test(`${e?.name ?? ""} ${e?.message ?? ""}`)

export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error)
    if (!isChunkError(error)) return
    try {
      const last = Number(sessionStorage.getItem(RELOAD_KEY) ?? 0)
      if (Date.now() - last < 30_000) return // already reloaded just now: show the error instead of looping
      sessionStorage.setItem(RELOAD_KEY, String(Date.now()))
    } catch {
      // storage blocked: still reload once (this effect runs once per error)
    }
    window.location.reload()
  }, [error])

  return (
    <div className="min-h-screen grid place-items-center bg-background px-6 text-center">
      <div className="max-w-md">
        <p className="font-mono text-xs uppercase tracking-widest text-destructive">Something went wrong</p>
        <h1 className="mt-3 font-display text-3xl font-semibold text-foreground">Unexpected error</h1>
        <p className="mt-2 text-sm text-muted-foreground">An error occurred while loading this page. Please try again.</p>
        <Button onClick={() => (isChunkError(error) ? window.location.reload() : reset())} className="mt-6">Try again</Button>
        {/* Short reference for support: the digest maps to the server log; the name says what kind of failure. */}
        <p className="mt-4 font-mono text-[10px] text-muted-foreground/70">
          {error?.name || "Error"}{error?.digest ? ` · ${error.digest}` : ""}
        </p>
      </div>
    </div>
  )
}
