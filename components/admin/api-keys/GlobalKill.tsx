"use client"

import { useState } from "react"
import { AlertTriangle, Loader2, OctagonX } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"

/** Emergency stop: disables every v1 key, revokes every v2 key and turns the v2 API off. */
export function GlobalKill({ onConfirm }: { onConfirm: () => Promise<void> }) {
  const [open, setOpen] = useState(false)
  const [running, setRunning] = useState(false)

  const run = async () => {
    setRunning(true)
    try {
      await onConfirm()
    } finally {
      setRunning(false)
      setOpen(false)
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-rose-500/30 bg-rose-500/[0.05] p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 gap-3">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-rose-600 dark:text-rose-400" aria-hidden />
        <div className="min-w-0 text-sm">
          <p className="font-semibold text-foreground">Emergency kill switch</p>
          <p className="text-muted-foreground">Disables every v1 key, revokes every v2 key and turns the v2 API off.</p>
        </div>
      </div>
      <AlertDialog open={open} onOpenChange={(v) => !running && setOpen(v)}>
        <AlertDialogTrigger asChild>
          <button
            type="button"
            className="inline-flex h-10 shrink-0 items-center justify-center rounded-xl border border-rose-500/60 bg-background px-4 text-sm font-semibold text-rose-600 transition-colors hover:bg-rose-600 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500 dark:bg-transparent dark:text-rose-400"
          >
            <OctagonX className="mr-2 size-4" aria-hidden />
            Global Kill
          </button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-destructive">
              <OctagonX className="size-5" aria-hidden />
              Shut down all API access?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Every v1 key is disabled, every v2 key is revoked (developers must generate new keys and wait for approval)
              and the v2 API is switched off. Use this only during an active attack or a critical bug. The result of each
              step is shown when it finishes.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={running}>Cancel</AlertDialogCancel>
            <Button variant="destructive" onClick={run} disabled={running}>
              {running && <Loader2 className="mr-2 size-4 animate-spin" aria-hidden />}
              {running ? "Shutting down…" : "Confirm shutdown"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
