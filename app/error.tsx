"use client"
import { useEffect } from "react"
import { Button } from "@/components/ui/button"

export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => { console.error(error) }, [error])
  return (
    <div className="min-h-screen grid place-items-center bg-background px-6 text-center">
      <div className="max-w-md">
        <p className="font-mono text-xs uppercase tracking-widest text-destructive">Something went wrong</p>
        <h1 className="mt-3 font-display text-3xl font-semibold text-foreground">Unexpected error</h1>
        <p className="mt-2 text-sm text-muted-foreground">An error occurred while loading this page. Please try again.</p>
        <Button onClick={reset} className="mt-6">Try again</Button>
      </div>
    </div>
  )
}
