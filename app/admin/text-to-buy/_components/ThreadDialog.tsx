"use client"

import { useEffect, useState } from "react"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { adminFetch, ApiError, TTB_API, type AdminMessage } from "./api"
import { outcomeLabel, ttbErrorMessage } from "./format"

type Target = { sender: string; messageId: string }

/** The whole conversation with one number. Held in component state only; closing the dialog drops it. */
export function ThreadDialog({ target, onClose, onChanged }: { target: Target | null; onClose: () => void; onChanged: () => void }) {
  const [thread, setThread] = useState<AdminMessage[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<"block" | "unblock" | "misread" | null>(null)

  useEffect(() => {
    setThread(null)
    setError(null)
    setBusy(null)
    if (!target) return
    let cancelled = false
    // The number goes in the query of an API call (never the page URL) and the response is no-store.
    adminFetch<{ messages: AdminMessage[] }>(`/api/admin/text-to-buy/messages?thread=${encodeURIComponent(target.sender)}`)
      .then((r) => !cancelled && setThread(r.messages))
      .catch((e) => !cancelled && setError(ttbErrorMessage(e instanceof ApiError ? e.code : undefined)))
    return () => {
      cancelled = true
    }
  }, [target])

  if (!target) return null

  async function act(kind: "block" | "unblock" | "misread") {
    if (!target) return
    setBusy(kind)
    setError(null)
    try {
      const body = kind === "misread" ? { action: "misread", messageId: target.messageId } : { action: kind, sender: target.sender }
      await adminFetch(TTB_API, { method: "POST", body })
      toast.success(kind === "block" ? "Number blocked" : kind === "unblock" ? "Number unblocked" : "Marked as misread")
      onChanged()
    } catch (e) {
      setError(ttbErrorMessage(e instanceof ApiError ? e.code : undefined))
    } finally {
      setBusy(null)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Conversation</DialogTitle>
          <DialogDescription className="font-mono">{target.sender}</DialogDescription>
        </DialogHeader>

        <div className="space-y-2 text-sm">
          {!thread && !error && <p className="text-muted-foreground">Loading...</p>}
          {thread?.length === 0 && <p className="text-muted-foreground">No messages.</p>}
          {thread?.map((m) => (
            <div key={m.id} className={`flex flex-col ${m.direction === "out" ? "items-end" : "items-start"}`}>
              <div
                className={`max-w-[85%] whitespace-pre-wrap break-words rounded-2xl px-3 py-2 ${
                  m.direction === "out" ? "bg-primary text-primary-foreground" : "bg-muted"
                } ${m.id === target.messageId ? "ring-2 ring-primary/50" : ""}`}
              >
                {m.body}
              </div>
              <div className="mt-0.5 text-[11px] text-muted-foreground">
                {new Date(m.createdAt).toLocaleString()}
                {m.direction === "in" && m.outcome ? ` · ${outcomeLabel(m.outcome)}` : ""}
                {m.misread ? " · marked misread" : ""}
              </div>
            </div>
          ))}
          {error && <p className="text-sm text-red-600 dark:text-red-400" role="alert">{error}</p>}
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="outline" onClick={() => void act("misread")} disabled={busy !== null}>
            {busy === "misread" && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Mark as misread
          </Button>
          <Button variant="outline" onClick={() => void act("unblock")} disabled={busy !== null}>
            {busy === "unblock" && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Unblock number
          </Button>
          <Button variant="destructive" onClick={() => void act("block")} disabled={busy !== null}>
            {busy === "block" && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Block number
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
