"use client"

import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import type { ProviderName } from "@/lib/ai-provider-config"
import { catalogFor, costPer1000Messages, formatCostPer1000, MESSAGE_TOKEN_ASSUMPTION } from "@/lib/ai-models/catalog"

function usd(n: number): string {
  return n < 1 ? `$${n.toFixed(2)}` : `$${Number.isInteger(n) ? n : n.toFixed(2)}`
}

export function ModelCards({
  provider, model, onChange, modelError = false,
}: { provider: ProviderName; model: string; onChange: (model: string) => void; modelError?: boolean }) {
  const models = catalogFor(provider)
  const isOther = !models.some((m) => m.id === model)
  const src = models[0]
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {models.map((m) => {
          const selected = m.id === model
          const cost = costPer1000Messages(m.inUsdPerM, m.outUsdPerM)
          return (
            <button
              key={m.id}
              type="button"
              aria-pressed={selected}
              onClick={() => onChange(m.id)}
              className={`rounded-xl border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${selected ? "border-primary bg-primary/5 ring-1 ring-primary" : "border-border bg-card hover:border-primary/50"}`}
            >
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-sm font-semibold text-foreground">{m.label}</span>
                {m.badge && <Badge variant="secondary" className="text-[10px]">{m.badge}</Badge>}
                {m.tools && <Badge variant="outline" className="text-[10px]">✓ Tools</Badge>}
              </div>
              <p className="mt-0.5 break-all font-mono text-[11px] text-muted-foreground">{m.id}</p>
              <p className="mt-1.5 text-xs text-muted-foreground">{m.description}</p>
              {m.note && <p className="mt-1.5 text-[11px] text-muted-foreground">{m.note}</p>}
              <p className="mt-1.5 text-xs text-foreground">
                {m.inUsdPerM === null || m.outUsdPerM === null
                  ? "Price not checked"
                  : `${usd(m.inUsdPerM)} in / ${usd(m.outUsdPerM)} out per 1M tokens`}
              </p>
              <p className="text-xs text-muted-foreground">About {formatCostPer1000(cost)} per 1,000 messages</p>
            </button>
          )
        })}
        <div
          className={`rounded-xl border p-3 ${isOther ? "border-primary bg-primary/5 ring-1 ring-primary" : "border-border bg-card"}`}
        >
          <span className="text-sm font-semibold text-foreground">Other model</span>
          <p className="mt-1 text-xs text-muted-foreground">Type any model id your provider offers.</p>
          <Input
            aria-label="Other model id"
            value={isOther ? model : ""}
            onChange={(e) => onChange(e.target.value.trim())}
            placeholder="model-id"
            className="mt-2 h-8 font-mono text-xs"
          />
          {modelError
            ? <p className="mt-1.5 text-xs text-destructive">Enter a model id</p>
            : <p className="mt-1.5 text-xs text-muted-foreground">Price not checked</p>}
        </div>
      </div>
      {src && (
        <p className="text-[11px] text-muted-foreground">
          Prices are USD per million tokens, taken from the provider&apos;s own pricing page on {src.checkedOn}.
          &ldquo;Per 1,000 messages&rdquo; assumes about {MESSAGE_TOKEN_ASSUMPTION.inTokens.toLocaleString()} tokens in and{" "}
          {MESSAGE_TOKEN_ASSUMPTION.outTokens} tokens out per message. Real cost varies.{" "}
          <a href={src.sourceUrl} target="_blank" rel="noreferrer" className="underline">Source</a>
        </p>
      )}
    </div>
  )
}
