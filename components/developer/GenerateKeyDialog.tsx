// components/developer/GenerateKeyDialog.tsx
"use client"

import { useState } from "react"
import { KeyRound } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Callout } from "@/components/developer/docs/Callout"
import { CopyButton } from "@/components/developer/docs/CodeTabs"
import type { Environment, KeyStatus, KeyType } from "@/lib/api-v2/keys"

/** The one-time result of POST /api/user/v2-keys. Lives only in the page's component state until the dialog closes. */
export interface IssuedKey {
  key: string
  key_type: KeyType
  environment: Environment
  status: KeyStatus
}

const TYPE_LABEL: Record<KeyType, string> = { standard: "Standard", commission: "Commission", sms: "SMS" }

/**
 * Dialog body, split out so it can be rendered inline (e.g. a preview) without a portal.
 * `onCopied` fires after a successful copy; `acknowledged` is copied-or-ticked.
 */
export function IssuedKeyBody({
  issued,
  acknowledged,
  onCopied,
  saved,
  onSavedChange,
}: {
  issued: IssuedKey
  acknowledged: boolean
  onCopied: () => void
  saved: boolean
  onSavedChange: (v: boolean) => void
}) {
  const env = issued.environment === "live" ? "live" : "test"
  return (
    <div className="min-w-0 space-y-4">
      <Callout tone="warning" title="This key is shown only once">
        Copy it now and store it somewhere safe, such as your server&apos;s environment variables. Datagod keeps only a fingerprint, so
        if you lose this key you will have to regenerate it.
      </Callout>

      <div className="overflow-hidden rounded-xl border border-slate-800 bg-slate-950 shadow-sm dark:border-white/10">
        <div className="flex items-center justify-between gap-3 border-b border-white/10 bg-slate-900 py-1.5 pl-4 pr-1.5">
          <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-400">
            {TYPE_LABEL[issued.key_type]} · {env}
          </span>
          <CopyButton text={issued.key} label="API key" onCopied={onCopied} />
        </div>
        <p
          className="m-0 select-all whitespace-pre-wrap break-all p-4 font-mono text-[13px] leading-6 text-slate-100"
          aria-label="Your new API key"
        >
          {issued.key}
        </p>
      </div>

      {issued.status === "pending" ? (
        <Callout tone="info" title="Waiting for approval">
          Live keys must be approved by an admin before they can make requests. The status on this page changes to Active once
          approved; you can configure your integration in the meantime.
        </Callout>
      ) : (
        <Callout tone="info" title="Ready to use">
          This {env} key is active now. Send it in the <code className="font-mono text-foreground">Authorization</code> header on every request, as shown in the documentation.
        </Callout>
      )}

      <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-border p-3 text-sm text-foreground">
        <Checkbox checked={saved} onCheckedChange={(v) => onSavedChange(v === true)} className="mt-0.5" />
        <span>I have saved this key somewhere safe.</span>
      </label>
      {!acknowledged && (
        <p className="text-xs text-muted-foreground">Copy the key or tick the box above to close this window.</p>
      )}
    </div>
  )
}

/**
 * Shows a freshly generated key once. It cannot be dismissed by backdrop click or Escape, and its
 * Done button stays disabled until the key was copied or the "I have saved" box is ticked.
 * `onClose` must drop the key from state; nothing here persists it.
 */
export function GenerateKeyDialog({ issued, onClose }: { issued: IssuedKey | null; onClose: () => void }) {
  return (
    <Dialog open={issued !== null} onOpenChange={() => { /* closing is only possible through Done */ }}>
      {issued && <IssuedKeyDialogContent key={issued.key} issued={issued} onClose={onClose} />}
    </Dialog>
  )
}

function IssuedKeyDialogContent({ issued, onClose }: { issued: IssuedKey; onClose: () => void }) {
  const [copied, setCopied] = useState(false)
  const [saved, setSaved] = useState(false)
  const acknowledged = copied || saved

  return (
    <DialogContent
      showCloseButton={false}
      onInteractOutside={(e) => e.preventDefault()}
      onEscapeKeyDown={(e) => {
        e.preventDefault()
        if (acknowledged) onClose()
      }}
      className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl"
    >
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <KeyRound className="size-5 text-primary" aria-hidden /> Your new API key
        </DialogTitle>
        <DialogDescription>
          {TYPE_LABEL[issued.key_type]} {issued.environment} key generated. Copy it before closing this window.
        </DialogDescription>
      </DialogHeader>
      <IssuedKeyBody issued={issued} acknowledged={acknowledged} onCopied={() => setCopied(true)} saved={saved} onSavedChange={setSaved} />
      <DialogFooter>
        <Button onClick={onClose} disabled={!acknowledged} className="h-10 rounded-xl px-6">
          Done
        </Button>
      </DialogFooter>
    </DialogContent>
  )
}
