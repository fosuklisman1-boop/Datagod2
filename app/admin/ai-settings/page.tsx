"use client"

import { useEffect, useState } from "react"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Eye, EyeOff, Save, Bot, RefreshCw } from "lucide-react"
import { supabase } from "@/lib/supabase"
import { toast } from "sonner"
import { ProviderName, PROVIDER_MODELS } from "@/lib/ai-provider-config"

type AIChatContext = "storefront" | "dashboard" | "admin" | "whatsapp"

interface ConfigState {
  anthropic_key_set: boolean
  anthropic_api_key_masked: string
  openai_key_set: boolean
  openai_api_key_masked: string
  gemini_key_set: boolean
  gemini_api_key_masked: string
  deepseek_key_set: boolean
  deepseek_api_key_masked: string
  groq_key_set: boolean
  groq_api_key_masked: string
  storefront_provider: ProviderName
  storefront_model: string
  dashboard_provider: ProviderName
  dashboard_model: string
  admin_provider: ProviderName
  admin_model: string
  whatsapp_provider: ProviderName
  whatsapp_model: string
}

const PROVIDER_LABELS: Record<ProviderName, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  gemini: "Google Gemini",
  deepseek: "DeepSeek",
  groq: "Groq",
}

const CONTEXT_LABELS: Record<AIChatContext, string> = {
  storefront: "Storefront",
  dashboard: "Dashboard",
  admin: "Admin",
  whatsapp: "WhatsApp Bot",
}

const defaultConfig: ConfigState = {
  anthropic_key_set: false,
  anthropic_api_key_masked: "",
  openai_key_set: false,
  openai_api_key_masked: "",
  gemini_key_set: false,
  gemini_api_key_masked: "",
  deepseek_key_set: false,
  deepseek_api_key_masked: "",
  groq_key_set: false,
  groq_api_key_masked: "",
  storefront_provider: "anthropic",
  storefront_model: "claude-haiku-4-5-20251001",
  dashboard_provider: "anthropic",
  dashboard_model: "claude-haiku-4-5-20251001",
  admin_provider: "anthropic",
  admin_model: "claude-haiku-4-5-20251001",
  whatsapp_provider: "anthropic",
  whatsapp_model: "claude-haiku-4-5-20251001",
}

export default function AISettingsPage() {
  const [token, setToken] = useState("")
  const [loading, setLoading] = useState(true)
  const [config, setConfig] = useState<ConfigState>(defaultConfig)

  // Separate state for new key inputs (only sent when non-empty)
  const [newKeys, setNewKeys] = useState({ anthropic: "", openai: "", gemini: "", deepseek: "", groq: "" })
  const [showKeys, setShowKeys] = useState({ anthropic: false, openai: false, gemini: false, deepseek: false, groq: false })
  const [savingKeys, setSavingKeys] = useState({ anthropic: false, openai: false, gemini: false, deepseek: false, groq: false })
  const [savingAssignment, setSavingAssignment] = useState(false)

  // "same for all" toggle
  const [sameForAll, setSameForAll] = useState(false)
  const [allProvider, setAllProvider] = useState<ProviderName>("anthropic")
  const [allModel, setAllModel] = useState("claude-haiku-4-5-20251001")

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) setToken(session.access_token)
    })
    fetchConfig()
  }, [])

  async function fetchConfig() {
    setLoading(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) return
      const res = await fetch("/api/admin/ai-config", {
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
      if (!res.ok) throw new Error("Failed to load")
      const data = await res.json() as ConfigState
      setConfig(data)

      // Detect if all four are using the same provider/model
      if (
        data.storefront_provider === data.dashboard_provider &&
        data.dashboard_provider === data.admin_provider &&
        data.admin_provider === data.whatsapp_provider &&
        data.storefront_model === data.dashboard_model &&
        data.dashboard_model === data.admin_model &&
        data.admin_model === data.whatsapp_model
      ) {
        setSameForAll(true)
        setAllProvider(data.storefront_provider)
        setAllModel(data.storefront_model)
      }
    } catch {
      toast.error("Failed to load AI settings")
    } finally {
      setLoading(false)
    }
  }

  async function saveKey(provider: "anthropic" | "openai" | "gemini" | "deepseek" | "groq") {
    const key = newKeys[provider].trim()
    if (!key) { toast.error("Enter a key first"); return }
    setSavingKeys(s => ({ ...s, [provider]: true }))
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const res = await fetch("/api/admin/ai-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session!.access_token}` },
        body: JSON.stringify({ [`${provider}_api_key_new`]: key }),
      })
      if (!res.ok) throw new Error("Failed to save")
      toast.success(`${PROVIDER_LABELS[provider]} API key saved`)
      setNewKeys(k => ({ ...k, [provider]: "" }))
      fetchConfig()
    } catch {
      toast.error("Failed to save key")
    } finally {
      setSavingKeys(s => ({ ...s, [provider]: false }))
    }
  }

  async function saveAssignment() {
    setSavingAssignment(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const payload = sameForAll
        ? {
            storefront_provider: allProvider, storefront_model: allModel,
            dashboard_provider: allProvider, dashboard_model: allModel,
            admin_provider: allProvider, admin_model: allModel,
            whatsapp_provider: allProvider, whatsapp_model: allModel,
          }
        : {
            storefront_provider: config.storefront_provider, storefront_model: config.storefront_model,
            dashboard_provider: config.dashboard_provider, dashboard_model: config.dashboard_model,
            admin_provider: config.admin_provider, admin_model: config.admin_model,
            whatsapp_provider: config.whatsapp_provider, whatsapp_model: config.whatsapp_model,
          }
      const res = await fetch("/api/admin/ai-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session!.access_token}` },
        body: JSON.stringify(payload),
      })
      if (!res.ok) throw new Error("Failed to save")
      toast.success("Model assignment saved — takes effect within 30 seconds")
      fetchConfig()
    } catch {
      toast.error("Failed to save assignment")
    } finally {
      setSavingAssignment(false)
    }
  }

  function setContextProvider(ctx: AIChatContext, provider: ProviderName) {
    const defaultModel = PROVIDER_MODELS[provider][0].id
    setConfig(c => ({
      ...c,
      [`${ctx}_provider`]: provider,
      [`${ctx}_model`]: defaultModel,
    }))
  }

  function setContextModel(ctx: AIChatContext, model: string) {
    setConfig(c => ({ ...c, [`${ctx}_model`]: model }))
  }

  const providers: ProviderName[] = ["anthropic", "openai", "gemini", "deepseek", "groq"]
  const keyInfo: { provider: "anthropic" | "openai" | "gemini" | "deepseek" | "groq"; label: string; placeholder: string; color: string }[] = [
    { provider: "anthropic", label: "Anthropic",    placeholder: "sk-ant-api03-...", color: "bg-orange-500" },
    { provider: "openai",    label: "OpenAI",       placeholder: "sk-proj-...",      color: "bg-green-600" },
    { provider: "gemini",    label: "Google Gemini",placeholder: "AIzaSy...",        color: "bg-primary"  },
    { provider: "deepseek",  label: "DeepSeek",     placeholder: "sk-...",           color: "bg-sky-500"   },
    { provider: "groq",      label: "Groq",         placeholder: "gsk_...",          color: "bg-primary"},
  ]

  return (
    <DashboardLayout>
      <div className="max-w-2xl mx-auto py-8 px-4 space-y-6">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-xl bg-primary">
            <Bot size={22} className="text-primary" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-foreground">AI Provider Settings</h1>
            <p className="text-sm text-muted-foreground">Configure API keys and assign models to each chat widget</p>
          </div>
          <button onClick={fetchConfig} className="ml-auto text-muted-foreground hover:text-muted-foreground">
            <RefreshCw size={16} className={loading ? "animate-spin" : ""} />
          </button>
        </div>

        {/* API Keys */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">API Keys</CardTitle>
            <p className="text-xs text-muted-foreground">Keys are stored encrypted. Existing keys are shown masked — enter a new value to replace.</p>
          </CardHeader>
          <CardContent className="space-y-4">
            {keyInfo.map(({ provider, label, placeholder, color }) => (
              <div key={provider} className="space-y-1.5">
                <div className="flex items-center gap-2">
                  <span className={`w-2 h-2 rounded-full ${color}`} />
                  <Label className="text-sm font-medium">{label}</Label>
                  {config[`${provider}_key_set` as keyof ConfigState]
                    ? <Badge variant="outline" className="text-[10px] text-success border-border">Configured</Badge>
                    : <Badge variant="outline" className="text-[10px] text-muted-foreground">Not set</Badge>
                  }
                </div>
                {config[`${provider}_api_key_masked` as keyof ConfigState] && (
                  <p className="text-xs text-muted-foreground font-mono pl-4">{String(config[`${provider}_api_key_masked` as keyof ConfigState])}</p>
                )}
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <Input
                      type={showKeys[provider] ? "text" : "password"}
                      placeholder={placeholder}
                      value={newKeys[provider]}
                      onChange={e => setNewKeys(k => ({ ...k, [provider]: e.target.value }))}
                      className="pr-9 text-sm font-mono"
                    />
                    <button
                      type="button"
                      onClick={() => setShowKeys(s => ({ ...s, [provider]: !s[provider] }))}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-muted-foreground"
                    >
                      {showKeys[provider] ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
                  </div>
                  <Button
                    size="sm"
                    onClick={() => saveKey(provider)}
                    disabled={savingKeys[provider] || !newKeys[provider].trim()}
                    className="gap-1.5"
                  >
                    <Save size={13} />
                    {savingKeys[provider] ? "Saving..." : "Save"}
                  </Button>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>

        {/* Model Assignment */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Model Assignment</CardTitle>
            <p className="text-xs text-muted-foreground">Choose which AI model powers each chat widget. Takes effect within 30 seconds.</p>
          </CardHeader>
          <CardContent className="space-y-5">
            {/* Same for all toggle */}
            <div className="flex items-start gap-3 p-3 rounded-xl border border-border bg-muted/40">
              <input
                type="checkbox"
                id="same-for-all"
                checked={sameForAll}
                onChange={e => setSameForAll(e.target.checked)}
                className="mt-0.5 accent-primary"
              />
              <label htmlFor="same-for-all" className="text-sm font-medium text-foreground cursor-pointer">
                Use the same model for all widgets
              </label>
            </div>

            {sameForAll ? (
              <div className="space-y-3 pl-1">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">Provider</Label>
                    <select
                      value={allProvider}
                      onChange={e => {
                        const p = e.target.value as ProviderName
                        setAllProvider(p)
                        setAllModel(PROVIDER_MODELS[p][0].id)
                      }}
                      className="w-full text-sm border border-border rounded-lg px-3 py-2 bg-card focus:outline-none focus:border-primary"
                    >
                      {providers.map(p => (
                        <option key={p} value={p}>{PROVIDER_LABELS[p]}</option>
                      ))}
                    </select>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">Model</Label>
                    <select
                      value={allModel}
                      onChange={e => setAllModel(e.target.value)}
                      className="w-full text-sm border border-border rounded-lg px-3 py-2 bg-card focus:outline-none focus:border-primary"
                    >
                      {PROVIDER_MODELS[allProvider].map(m => (
                        <option key={m.id} value={m.id}>{m.label}</option>
                      ))}
                    </select>
                  </div>
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                {(["storefront", "dashboard", "admin", "whatsapp"] as AIChatContext[]).map(ctx => (
                  <div key={ctx} className="space-y-2">
                    <Label className="text-sm font-medium capitalize">{CONTEXT_LABELS[ctx]} Widget</Label>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <Label className="text-xs text-muted-foreground">Provider</Label>
                        <select
                          value={config[`${ctx}_provider` as keyof ConfigState] as string}
                          onChange={e => setContextProvider(ctx, e.target.value as ProviderName)}
                          className="w-full text-sm border border-border rounded-lg px-3 py-2 bg-card focus:outline-none focus:border-primary"
                        >
                          {providers.map(p => (
                            <option key={p} value={p}>{PROVIDER_LABELS[p]}</option>
                          ))}
                        </select>
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs text-muted-foreground">Model</Label>
                        <select
                          value={config[`${ctx}_model` as keyof ConfigState] as string}
                          onChange={e => setContextModel(ctx, e.target.value)}
                          className="w-full text-sm border border-border rounded-lg px-3 py-2 bg-card focus:outline-none focus:border-primary"
                        >
                          {PROVIDER_MODELS[config[`${ctx}_provider` as keyof ConfigState] as ProviderName].map(m => (
                            <option key={m.id} value={m.id}>{m.label}</option>
                          ))}
                        </select>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            <Button
              onClick={saveAssignment}
              disabled={savingAssignment}
              className="w-full gap-2"
            >
              <Save size={15} />
              {savingAssignment ? "Saving..." : "Save Model Assignment"}
            </Button>
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  )
}
