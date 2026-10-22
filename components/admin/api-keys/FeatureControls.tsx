"use client"

import { useEffect, useState } from "react"
import { Check, Loader2, Power, Settings2, X } from "lucide-react"
import { Switch } from "@/components/ui/switch"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { V2_ROLES } from "@/lib/api-v2/lifecycle"
import { roleLabel, serverChangedUnderDraft, shouldSyncDraft, toggleRole } from "@/lib/api-v2/admin-view"
import type { ApiConfig } from "./use-console-data"
import { Eyebrow, IconChip, InlineError, Panel } from "./ui"
import { GlobalKill } from "./GlobalKill"

export function FeatureControls({
  config,
  error,
  onSave,
  onRetry,
  onGlobalKill,
}: {
  config: ApiConfig | null
  error: string | null
  onSave: (next: ApiConfig) => Promise<boolean>
  onRetry: () => void
  onGlobalKill: () => Promise<void>
}) {
  const [draft, setDraft] = useState<ApiConfig | null>(config)
  // The server values the draft was last synced from; lets a refresh update a clean draft
  // without throwing away unsaved edits.
  const [base, setBase] = useState<ApiConfig | null>(config)
  const [saving, setSaving] = useState(false)
  // Set after a Global Kill (success or partial): the next sync overwrites even a dirty draft, so an
  // unsaved "enabled" draft cannot switch v2 back on with the next Save.
  const [forceSync, setForceSync] = useState(false)

  useEffect(() => {
    if (shouldSyncDraft({ config, base, draft, force: forceSync })) {
      setDraft(config)
      setBase(config)
      setForceSync(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config, forceSync])

  const serverChanged = serverChangedUnderDraft({ config, base, draft })

  const discardDraft = () => {
    if (!config) return
    setDraft(config)
    setBase(config)
  }

  const globalKill = async () => {
    try {
      await onGlobalKill()
    } finally {
      setForceSync(true)
    }
  }

  const save = async () => {
    if (!draft) return
    setSaving(true)
    try {
      const saved = draft
      if (await onSave(saved)) setBase(saved)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Panel className="space-y-5">
      <header className="flex items-start gap-3">
        <IconChip icon={Settings2} />
        <div className="min-w-0">
          <h2 className="font-semibold text-foreground">Feature Controls</h2>
          <p className="text-sm text-muted-foreground">Global API access settings</p>
        </div>
      </header>

      {error && !config ? (
        <InlineError message={`Could not load settings: ${error}`} onRetry={onRetry} />
      ) : !draft ? (
        <div className="h-24 animate-pulse rounded-xl bg-muted" aria-label="Loading settings" />
      ) : (
        <>
          {error && (
            <div role="status" className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-300">
              <span className="min-w-0">Couldn&apos;t refresh settings; showing the last loaded values.</span>
              <button type="button" onClick={onRetry} className="shrink-0 rounded-lg px-2 py-1 text-xs font-semibold hover:underline">
                Retry
              </button>
            </div>
          )}
          {serverChanged && config && (
            <div role="status" className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-300">
              <span className="min-w-0">
                Settings changed on the server (API access is now {config.enabled ? "on" : "off"}). Saving will overwrite them with your edits.
              </span>
              <button type="button" onClick={discardDraft} className="shrink-0 rounded-lg px-2 py-1 text-xs font-semibold hover:underline">
                Load server values
              </button>
            </div>
          )}
          <label
            className={cn(
              "flex cursor-pointer items-center justify-between gap-3 rounded-xl border px-4 py-3 transition-colors",
              draft.enabled
                ? "border-emerald-500/40 bg-emerald-500/[0.08] dark:bg-emerald-500/10"
                : "border-border bg-muted/60 dark:bg-white/[0.03]"
            )}
          >
            <span className="flex min-w-0 items-center gap-2.5">
              <Power className={cn("size-4 shrink-0", draft.enabled ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground")} aria-hidden />
              <span className="min-w-0">
                <span className="block text-sm font-semibold text-foreground">
                  {draft.enabled ? "API Access Enabled" : "API Access Disabled"}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {draft.enabled ? "v2 keys can call the API." : "Every v2 request is refused."}
                </span>
              </span>
            </span>
            <Switch
              checked={draft.enabled}
              onCheckedChange={(v) => setDraft({ ...draft, enabled: v })}
              aria-label="API access"
              className="data-[state=checked]:bg-emerald-600"
            />
          </label>

          <div className="space-y-2.5">
            <Eyebrow>Allowed roles</Eyebrow>
            <div className="flex flex-wrap gap-2">
              {V2_ROLES.map((r) => {
                const on = draft.allowed_roles.includes(r)
                return (
                  <button
                    key={r}
                    type="button"
                    aria-pressed={on}
                    onClick={() => setDraft({ ...draft, allowed_roles: toggleRole(draft.allowed_roles, r) })}
                    className={cn(
                      "inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      on
                        ? "border-primary bg-primary/10 text-primary dark:bg-primary/15"
                        : "border-border bg-background text-muted-foreground hover:text-foreground dark:bg-transparent"
                    )}
                  >
                    {on ? <Check className="size-3.5" aria-hidden /> : <X className="size-3.5" aria-hidden />}
                    {roleLabel(r)}
                  </button>
                )
              })}
            </div>
            <p className="text-xs text-muted-foreground">Only selected roles can generate and use API keys.</p>
          </div>

          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-3">
              <Button onClick={save} disabled={saving} className="h-10 rounded-xl px-5 font-semibold">
                {saving && <Loader2 className="mr-2 size-4 animate-spin" aria-hidden />}
                Save Settings
              </Button>
              <p className="text-xs text-muted-foreground">Changes take effect immediately for new API requests.</p>
            </div>
          </div>
        </>
      )}

      <GlobalKill onConfirm={globalKill} />
    </Panel>
  )
}
