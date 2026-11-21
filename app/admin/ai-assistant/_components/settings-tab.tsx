"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { Save } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { supabase } from "@/lib/supabase"
import type { ProviderName } from "@/lib/ai-provider-config"
import { MIN_TOOL_STEPS, MAX_TOOL_STEPS } from "@/lib/ai-console/settings"
import { PROVIDERS, changedSettings, type ConsoleForm } from "@/lib/ai-console/engine"
import { EngineCard, isNameValid } from "./engine-card"
import { AudienceCard } from "./audience-card"

type KeyInfo = Record<ProviderName, { set: boolean; masked: string }>

const EMPTY_KEYS: Record<ProviderName, string> = { anthropic: "", openai: "", gemini: "", deepseek: "", groq: "" }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toForm(d: any): { form: ConsoleForm; keyInfo: KeyInfo } {
  const keyInfo = {} as KeyInfo
  for (const p of PROVIDERS) keyInfo[p] = { set: !!d[`${p}_key_set`], masked: d[`${p}_api_key_masked`] ?? "" }
  return {
    keyInfo,
    form: {
      assistant_name: d.assistant_name, tone: d.tone, audiences: d.audiences, max_tool_steps: d.max_tool_steps ?? null,
      storefront_provider: d.storefront_provider, storefront_model: d.storefront_model,
      dashboard_provider: d.dashboard_provider, dashboard_model: d.dashboard_model,
      admin_provider: d.admin_provider, admin_model: d.admin_model,
      whatsapp_provider: d.whatsapp_provider, whatsapp_model: d.whatsapp_model,
      keys: { ...EMPTY_KEYS },
    },
  }
}

function parseSteps(v: string): { value: number | null; error: string | null } {
  const t = v.trim()
  if (t === "") return { value: null, error: null }
  const n = Number(t)
  if (!Number.isInteger(n) || n < MIN_TOOL_STEPS || n > MAX_TOOL_STEPS) {
    return { value: null, error: `Enter a whole number from ${MIN_TOOL_STEPS} to ${MAX_TOOL_STEPS}, or leave empty.` }
  }
  return { value: n, error: null }
}

export function SettingsTab() {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [original, setOriginal] = useState<ConsoleForm | null>(null)
  const [form, setForm] = useState<ConsoleForm | null>(null)
  const [keyInfo, setKeyInfo] = useState<KeyInfo | null>(null)
  const [stepsText, setStepsText] = useState("")

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const res = await fetch("/api/admin/ai-config", { headers: { Authorization: `Bearer ${session?.access_token}` } })
      if (!res.ok) throw new Error("load")
      const parsed = toForm(await res.json())
      setOriginal(parsed.form)
      setForm(parsed.form)
      setKeyInfo(parsed.keyInfo)
      setStepsText(parsed.form.max_tool_steps === null ? "" : String(parsed.form.max_tool_steps))
    } catch {
      toast.error("Failed to load AI settings")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const steps = parseSteps(stepsText)
  const edited = useMemo(() => (form ? { ...form, max_tool_steps: steps.value } : null), [form, steps.value])
  const nameError = form && !isNameValid(form.assistant_name) ? "Name must be 2 to 24 letters, numbers, spaces or hyphens." : null
  const diff = original && edited ? changedSettings(original, edited) : {}
  const dirty = Object.keys(diff).length > 0
  const canSave = dirty && !nameError && !steps.error && !saving

  async function save() {
    if (!canSave) return
    setSaving(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const res = await fetch("/api/admin/ai-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token}` },
        body: JSON.stringify(diff),
      })
      if (!res.ok) throw new Error("save")
      toast.success("Saved. Changes apply within about 90 seconds.")
      await load()
    } catch {
      toast.error("Could not save. Nothing was changed.")
    } finally {
      setSaving(false)
    }
  }

  if (loading && !form) return <div className="py-12 text-center text-sm text-muted-foreground">Loading...</div>
  if (!form || !keyInfo) {
    return (
      <div className="py-12 text-center text-sm text-muted-foreground">
        Settings could not be loaded.{" "}
        <button type="button" onClick={() => void load()} className="underline">Try again</button>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
        <div className="lg:col-span-3">
          <EngineCard form={form} setForm={setForm} keyInfo={keyInfo} nameError={nameError} />
        </div>
        <div className="lg:col-span-2">
          <AudienceCard
            audiences={form.audiences}
            onChange={(a) => setForm({ ...form, audiences: a })}
            maxSteps={stepsText}
            onMaxSteps={setStepsText}
            stepsError={steps.error}
          />
        </div>
      </div>
      <div className="sticky bottom-0 z-10 -mx-1 flex items-center justify-between gap-3 rounded-xl border border-border bg-card/95 p-3 backdrop-blur">
        <p className="text-xs text-muted-foreground">Changes apply within about 90 seconds.</p>
        <Button onClick={save} disabled={!canSave} className="gap-2">
          <Save size={15} />
          {saving ? "Saving..." : "Save changes"}
        </Button>
      </div>
    </div>
  )
}
