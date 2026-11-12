"use client"

import { useEffect, useState } from "react"
import { Loader2 } from "lucide-react"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { adminErrorMessage } from "@/lib/momo-claim/admin-view"
import { adminFetch, ApiError, MOMO_API } from "./api"

/** Fetches the raw SMS only when opened (it holds names and numbers). */
export function RawSmsDialog({ txid, onClose }: { txid: string | null; onClose: () => void }) {
  const [sms, setSms] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setSms(null)
    setError(null)
    if (!txid) return
    let cancelled = false
    adminFetch<{ rawSms: string }>(`${MOMO_API}?raw=${encodeURIComponent(txid)}`)
      .then((r) => !cancelled && setSms(r.rawSms))
      .catch((e) => !cancelled && setError(adminErrorMessage(e instanceof ApiError ? e.code : undefined)))
    return () => {
      cancelled = true
    }
  }, [txid])

  return (
    <Dialog open={!!txid} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Original SMS</DialogTitle>
          <DialogDescription className="font-mono text-xs break-all">{txid}</DialogDescription>
        </DialogHeader>
        {error ? (
          <p className="text-sm text-red-600 dark:text-red-400" role="alert">{error}</p>
        ) : sms === null ? (
          <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin" /></div>
        ) : (
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/40 p-3 text-xs">{sms}</pre>
        )}
      </DialogContent>
    </Dialog>
  )
}
