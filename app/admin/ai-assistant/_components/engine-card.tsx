"use client"

import { useState } from "react"
import { ChevronDown, Eye, EyeOff } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import type { ProviderName } from "@/lib/ai-provider-config"
import { catalogFor } from "@/lib/ai-models/catalog"
import { normaliseAssistantName } from "@/lib/ai-chat-ui/assistant-name"
import {
  PROVIDERS, GLOBAL_CONTEXTS, applyEngine, globalEngine,
  type ConsoleForm, type ChatContext,
} from "@/lib/ai-console/engine"
import { TONES } from "@/lib/ai-console/tone"
import { ModelCards } from "./model-cards"
import { TONE_OPTIONS, TONE_SAFETY_NOTE } from "./tone-options"

export const PROVIDER_LABELS: Record<ProviderName, string> = {
  anthropic: "Anthropic", openai: "OpenAI", gemini: "Google Gemini", deepseek: "DeepSeek", groq: "Groq",
}
const KEY_PLACEHOLDER: Record<ProviderName, string> = {
  anthropic: "sk-ant-api03-...", openai: "sk-proj-...", gemini: "AIzaSy...", deepseek: "sk-...", groq: "gsk_...",
}
const CONTEXT_LABELS: Record<ChatContext, string> = {
  storefront: "Storefront / home", dashboard: "Dashboard", admin: "Admin", whatsapp: "WhatsApp bot",
}
const selectCls = "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:border-primary focus:outline-none"

export function isNameValid(name: string): boolean {
  const t = name.trim()
  return t.length > 0 && normaliseAssistantName(t) === t
}

function KeyField({ provider, idPrefix, keySet, masked, value, onChange }: {
  provider: ProviderName; idPrefix: string; keySet: boolean; masked: string; value: string; onChange: (v: string) => void
}) {
  const [show, setShow] = useState(false)
  return (
    <div className="space-y-1">
      <Label htmlFor={`${idPrefix}-${provider}`} className="text-sm font-medium">{PROVIDER_LABELS[provider]} API key</Label>
      <div className="relative">
        <Input
          id={`${idPrefix}-${provider}`}
          type={show ? "text" : "password"}
          autoComplete="off"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={keySet ? "Paste a new key to replace" : KEY_PLACEHOLDER[provider]}
          className="pr-9 font-mono text-sm"
        />
        <button
          type="button"
          aria-label={show ? "Hide key" : "Show key"}
          onClick={() => setShow((s) => !s)}
          className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
        >
          {show ? <EyeOff size={14} /> : <Eye size={14} />}
        </button>
      </div>
      <p className="text-xs text-muted-foreground">
        {keySet
          ? <>Saved{masked ? <> (<span className="font-mono">{masked}</span>)</> : null}. Paste a new key to replace it.</>
          : "No key saved yet. Paste one to enable this provider."}
      </p>
    </div>
  )
}

export function EngineCard({ form, setForm, keyInfo, nameError }: {
  form: ConsoleForm
  setForm: (f: ConsoleForm) => void
  keyInfo: Record<ProviderName, { set: boolean; masked: string }>
  nameError: string | null
}) {
  const engine = globalEngine(form)
  const mixed = engine === null
  // While mixed, the pickers show the dashboard values but nothing is highlighted until the admin picks.
  const provider = engine?.provider ?? form.dashboard_provider
  const model = engine?.model ?? ""
  const previewName = isNameValid(form.assistant_name) ? form.assistant_name.trim() : "…"
  const tone = TONE_OPTIONS.find((t) => t.id === form.tone) ?? TONE_OPTIONS[0]

  function pickProvider(p: ProviderName) {
    setForm(applyEngine(form, p, catalogFor(p)[0].id))
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Engine</CardTitle>
        <p className="text-xs text-muted-foreground">How the assistant introduces itself, sounds, and which AI model answers.</p>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="space-y-1">
          <Label htmlFor="assistant-name" className="text-sm font-medium">Name</Label>
          <Input
            id="assistant-name"
            value={form.assistant_name}
            maxLength={24}
            onChange={(e) => setForm({ ...form, assistant_name: e.target.value })}
            aria-invalid={nameError ? true : undefined}
          />
          <p className={`text-xs ${nameError ? "text-destructive" : "text-muted-foreground"}`}>
            {nameError ?? "2 to 24 letters, numbers, spaces or hyphens."}
          </p>
          <p className="text-xs text-foreground">Preview: Hi Ama, I am {previewName}</p>
        </div>

        <div className="space-y-2">
          <Label className="text-sm font-medium">Tone</Label>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3" role="radiogroup" aria-label="Tone">
            {TONE_OPTIONS.filter((t) => (TONES as readonly string[]).includes(t.id)).map((t) => (
              <button
                key={t.id}
                type="button"
                role="radio"
                aria-checked={form.tone === t.id}
                onClick={() => setForm({ ...form, tone: t.id })}
                className={`rounded-xl border p-3 text-left transition-colors ${form.tone === t.id ? "border-primary bg-primary/5 ring-1 ring-primary" : "border-border bg-card hover:border-primary/50"}`}
              >
                <span className="text-sm font-semibold text-foreground">{t.title}</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">{t.blurb}</span>
              </button>
            ))}
          </div>
          <p className="rounded-lg bg-muted/50 p-3 text-xs text-foreground">
            <span className="font-semibold">Example:</span> {tone.example}
          </p>
          <p className="text-[11px] text-muted-foreground">{TONE_SAFETY_NOTE}</p>
        </div>

        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Label htmlFor="engine-provider" className="text-sm font-medium">Provider</Label>
            {mixed && <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold text-muted-foreground">Mixed — see Advanced</span>}
          </div>
          <select id="engine-provider" value={provider} onChange={(e) => pickProvider(e.target.value as ProviderName)} className={selectCls}>
            {PROVIDERS.map((p) => <option key={p} value={p}>{PROVIDER_LABELS[p]}</option>)}
          </select>
          <p className="text-xs text-muted-foreground">Applies to all chats except WhatsApp. Pick a model to apply it everywhere.</p>
        </div>

        <div className="space-y-2">
          <Label className="text-sm font-medium">Model</Label>
          <ModelCards provider={provider} model={model} onChange={(m) => setForm(applyEngine(form, provider, m))} />
        </div>

        <KeyField
          idPrefix="key"
          provider={provider}
          keySet={keyInfo[provider].set}
          masked={keyInfo[provider].masked}
          value={form.keys[provider]}
          onChange={(v) => setForm({ ...form, keys: { ...form.keys, [provider]: v } })}
        />

        <AdvancedOverrides form={form} setForm={setForm} keyInfo={keyInfo} />
      </CardContent>
    </Card>
  )
}

function AdvancedOverrides({ form, setForm, keyInfo }: {
  form: ConsoleForm; setForm: (f: ConsoleForm) => void; keyInfo: Record<ProviderName, { set: boolean; masked: string }>
}) {
  const [open, setOpen] = useState(false)
  const contexts: ChatContext[] = [...GLOBAL_CONTEXTS, "whatsapp"]
  return (
    <div className="rounded-xl border border-border">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between p-3 text-left text-sm font-medium text-foreground"
      >
        Advanced: per-chat overrides and API keys
        <ChevronDown size={16} className={`transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div className="space-y-5 border-t border-border p-3">
          {contexts.map((c) => {
            const p = form[`${c}_provider`]
            const m = form[`${c}_model`]
            const list = catalogFor(p)
            return (
              <div key={c} className="space-y-1">
                <Label className="text-sm font-medium">{CONTEXT_LABELS[c]}</Label>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <select
                    aria-label={`${CONTEXT_LABELS[c]} provider`}
                    value={p}
                    onChange={(e) => {
                      const np = e.target.value as ProviderName
                      setForm({ ...form, [`${c}_provider`]: np, [`${c}_model`]: catalogFor(np)[0].id })
                    }}
                    className={selectCls}
                  >
                    {PROVIDERS.map((x) => <option key={x} value={x}>{PROVIDER_LABELS[x]}</option>)}
                  </select>
                  <select
                    aria-label={`${CONTEXT_LABELS[c]} model`}
                    value={m}
                    onChange={(e) => setForm({ ...form, [`${c}_model`]: e.target.value })}
                    className={selectCls}
                  >
                    {!list.some((x) => x.id === m) && <option value={m}>{m}</option>}
                    {list.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
                  </select>
                </div>
              </div>
            )
          })}
          <div className="space-y-4 border-t border-border pt-4">
            <p className="text-xs text-muted-foreground">Keys are write-only. Leave a field empty to keep the saved key.</p>
            {PROVIDERS.map((p) => (
              <KeyField
                idPrefix="adv-key"
                key={p}
                provider={p}
                keySet={keyInfo[p].set}
                masked={keyInfo[p].masked}
                value={form.keys[p]}
                onChange={(v) => setForm({ ...form, keys: { ...form.keys, [p]: v } })}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
