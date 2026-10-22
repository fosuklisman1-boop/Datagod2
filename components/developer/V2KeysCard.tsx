// components/developer/V2KeysCard.tsx
"use client"

import { Coins, Loader2, MessageSquareText, RotateCw, Wallet } from "lucide-react"
import { Callout } from "@/components/developer/docs/Callout"
import { Button } from "@/components/ui/button"
import type { Environment, KeyType } from "@/lib/api-v2/keys"
import type { AccessReason, AccessSummary } from "@/lib/api-v2/key-issue"
import type { V2KeySummary } from "@/lib/api-v2/key-slots"
import { V2KeyBlock, type KeyTypeMeta } from "./V2KeyBlock"

const KEY_TYPES: KeyTypeMeta[] = [
  {
    type: "standard",
    title: "Standard key",
    description: "Data bundles, wallet, orders, the results checker and AFA registration. Most integrations only need this key.",
    prefix: "dg2_test_ / dg2_live_",
    icon: Wallet,
  },
  {
    type: "commission",
    title: "Commission key",
    description: "Commission Services: airtime and utility bill payments. Each key works only with its own endpoint group.",
    prefix: "dg2_cs_test_ / dg2_cs_live_",
    icon: Coins,
  },
]

const DENIED: Record<Exclude<AccessReason, "ok">, { title: string; body: string }> = {
  disabled: {
    title: "The v2 API is not open yet",
    body: "Datagod has not switched on v2 API keys for accounts yet, so you cannot generate one right now. You can read the Documentation tab and prepare your integration in the meantime. Contact support if you need access early.",
  },
  suspended: {
    title: "Your account is suspended",
    body: "Suspended accounts cannot create API keys. Contact support to resolve the suspension; once it is lifted you can generate keys here.",
  },
  role_not_allowed: {
    title: "Your account type cannot create v2 keys yet",
    body: "API keys are currently available to selected account types only. Contact support if you would like API access for your account.",
  },
}

/** Plain-words explanation of why generation is unavailable. */
export function AccessDeniedCallout({ reason }: { reason: Exclude<AccessReason, "ok"> }) {
  const d = DENIED[reason]
  return (
    <Callout tone="warning" title={d.title}>
      {d.body}
    </Callout>
  )
}

/**
 * Shown when the keys/access answer could not be loaded. Deliberately offers no generate controls
 * (fail closed); the only action is Retry.
 */
export function LoadErrorCallout({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <Callout tone="warning" title="We could not load your API keys">
      <p className="break-words">
        {message.replace(/[.!\s]+$/, "")}. This is usually a network problem; your keys are not affected. Check your connection and try again.
      </p>
      <Button type="button" variant="outline" size="sm" className="mt-2" onClick={onRetry}>
        <RotateCw className="size-4" aria-hidden /> Retry
      </Button>
    </Callout>
  )
}

/** The "how keys work" explanation shown above the key blocks. */
export function KeysExplainer() {
  return (
    <Callout tone="info" title="How v2 keys work">
      <ul className="mt-1 list-disc space-y-1 pl-4">
        <li><strong className="text-foreground">Test keys</strong> work in the sandbox and are active the moment you generate them. They never touch real money or real orders.</li>
        <li><strong className="text-foreground">Live keys</strong> wait for an admin to approve them. Until then they show <em>Waiting for approval</em> and cannot make requests.</li>
        <li><strong className="text-foreground">Regenerating a live key</strong> revokes the old key straight away, and the replacement starts as <em>Waiting for approval</em> again until it is re-approved.</li>
        <li>The full key is shown <strong className="text-foreground">only once</strong>, right after you generate it. We only store a fingerprint, so a lost key cannot be recovered, only replaced.</li>
      </ul>
    </Callout>
  )
}

function SmsComingSoon() {
  return (
    <section aria-label="SMS keys" className="min-w-0 rounded-2xl border border-dashed border-border bg-card/60 p-4 sm:p-5">
      <header className="flex items-start gap-3 opacity-80">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground"><MessageSquareText className="size-5" aria-hidden /></span>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-base font-bold text-foreground">SMS key</h3>
            <span className="rounded-full border border-border bg-muted px-2.5 py-0.5 text-[11px] font-semibold text-muted-foreground">Coming soon</span>
          </div>
          <p className="text-xs leading-5 text-muted-foreground">
            A separate key for the SMS endpoints. SMS keys arrive in a later release and will be generated from the SMS dashboard; there is nothing to set up yet.
          </p>
        </div>
      </header>
    </section>
  )
}

export interface V2KeysCardProps {
  keys: V2KeySummary[]
  access: AccessSummary | null
  loading?: boolean
  busySlot: string | null
  onGenerate: (type: KeyType, env: Environment) => void
  onRevoke: (key: V2KeySummary) => void
}

/** Presentational: everything comes in through props so it can be previewed without the network. */
export function V2KeysCard({ keys, access, loading, busySlot, onGenerate, onRevoke }: V2KeysCardProps) {
  if (loading || !access) {
    return (
      <div className="flex items-center justify-center gap-2 rounded-2xl border border-white/60 bg-card p-10 text-sm text-muted-foreground clay dark:border-white/5">
        <Loader2 className="size-4 animate-spin" aria-hidden /> Loading your API keys…
      </div>
    )
  }

  const handlers = { canGenerate: access.canGenerate, busySlot, onGenerate, onRevoke }
  const usable = keys.filter((k) => k.status === "pending" || k.status === "active")
  // When generation is unavailable, only show key types the user still holds keys for (so they can revoke them).
  const types = access.canGenerate ? KEY_TYPES : KEY_TYPES.filter((m) => usable.some((k) => k.key_type === m.type))

  return (
    <div className="space-y-4">
      {access.reason !== "ok" && <AccessDeniedCallout reason={access.reason} />}
      {types.length > 0 && (
        <div className="grid gap-4 lg:grid-cols-2">
          {types.map((m) => (
            <V2KeyBlock key={m.type} meta={m} keys={keys} h={handlers} />
          ))}
        </div>
      )}
      {access.canGenerate && <SmsComingSoon />}
    </div>
  )
}
