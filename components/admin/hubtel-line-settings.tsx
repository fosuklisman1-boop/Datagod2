"use client"

import { useEffect, useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { hubtelSaveBody } from "@/lib/ussd-hubtel/line"
import { IMPLEMENTED_SERVICES } from "@/lib/ussd-hubtel/menus"
import {
  BRAND_MAX, DEFAULT_BRAND, WELCOME_MAX, derivedWelcome, validateBrandName, validateWelcome, type HubtelUssdConfig,
} from "@/lib/ussd-hubtel/config"

/** Commission Cashback bot menus: shown only when this toggle AND the cashback bots switches are on. */
const CASHBACK_SERVICES: { key: "networkPlans" | "payBills"; label: string }[] = [
  { key: "networkPlans", label: "Internet Bundles: Standard Bundles" },
  { key: "payBills", label: "Pay Bills" },
]

const SERVICES: { key: Exclude<keyof HubtelUssdConfig["visibility"], "networkPlans" | "payBills">; label: string }[] = [
  { key: "data", label: "Internet Bundles: Data Bundles" },
  { key: "afa", label: "AFA Registration" },
  { key: "airtime", label: "Buy Airtime" },
  { key: "resultsChecker", label: "Results Checker" },
]

/** The settings of one Hubtel code. `line` says which: "shop" is the existing URL, "main" the new main code. */
export function HubtelLineSettings({ line, config, envOk, busy, onSave }: {
  line: "shop" | "main"
  config: HubtelUssdConfig | null
  envOk: boolean
  busy: string | null
  /** Receives the request body, already marked with this code's line. */
  onSave: (body: object, label: string) => void
}) {
  const isShopLine = line === "shop"
  // Labels carry the line, so saving on one tab never disables the other tab's controls.
  const label = (name: string) => `${line}:${name}`
  const isBusy = (name: string) => busy === label(name)
  const save = (patch: object, name: string) => onSave(hubtelSaveBody(line, patch), label(name))

  // Brand name: re-synced from the server value on load / save / reset.
  const [brandDraft, setBrandDraft] = useState("")
  const savedBrand = config?.brandName
  useEffect(() => { if (savedBrand !== undefined) setBrandDraft(savedBrand) }, [savedBrand])
  const brandCheck = validateBrandName(brandDraft)
  const brandUnchanged = brandCheck.ok && brandCheck.value === savedBrand
  // Brand used for live previews: the draft while it is valid, else the saved one.
  const previewBrand = brandCheck.ok ? brandCheck.value : (savedBrand ?? DEFAULT_BRAND)

  // Welcome: the field holds ONLY the custom override; blank means "Welcome to <brand>".
  const [welcomeDraft, setWelcomeDraft] = useState("")
  const savedCustomWelcome = config ? (config.welcomeCustom ? config.welcome : "") : undefined
  useEffect(() => { if (savedCustomWelcome !== undefined) setWelcomeDraft(savedCustomWelcome) }, [savedCustomWelcome])
  const welcomeBlank = welcomeDraft.trim() === ""
  const welcomeCheck = validateWelcome(welcomeDraft)
  const welcomeValid = welcomeBlank || welcomeCheck.ok
  const welcomeUnchanged = welcomeBlank ? savedCustomWelcome === "" : welcomeCheck.ok && welcomeCheck.value === savedCustomWelcome
  const previewWelcome = welcomeBlank ? derivedWelcome(previewBrand) : welcomeDraft.trim()

  return (
    <div className="space-y-6">
      {isShopLine ? (
        <p className="text-sm text-muted-foreground">These settings apply to the existing URL, with no line parameter.</p>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>URLs to register with Hubtel</CardTitle>
            <CardDescription>Give Hubtel these for the main code, with the secret filled in. The secret is never shown here.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div>
              <div className="font-medium">Service Interaction URL</div>
              <code className="break-all text-xs text-muted-foreground">{"https://www.datagod.store/api/ussd-hubtel/interaction?secret=<HUBTEL_WEBHOOK_SECRET>&line=main"}</code>
            </div>
            <div>
              <div className="font-medium">Service Fulfilment URL (same for both codes)</div>
              <code className="break-all text-xs text-muted-foreground">{"https://www.datagod.store/api/ussd-hubtel/fulfillment?secret=<HUBTEL_WEBHOOK_SECRET>"}</code>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Channel</CardTitle>
          <CardDescription>
            {isShopLine
              ? "The kill switch ships OFF. Turn it on only after the runbook checks pass."
              : "Starts OFF. This switch affects only the main code. Turn it on only after the runbook checks pass."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {!config ? <p className="text-sm text-muted-foreground">Loading...</p> : (
            <>
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">{isShopLine ? "Hubtel USSD enabled" : "Main code enabled"}</span>
                <Switch checked={config.enabled} disabled={isBusy("enabled") || (!config.enabled && !envOk)} aria-label={isShopLine ? "Toggle Hubtel USSD" : "Toggle Hubtel main code"}
                  onCheckedChange={v => save({ enabled: v }, "enabled")} />
              </div>
              {!envOk && <p className="text-xs text-amber-600">Cannot enable until all environment variables below are configured.</p>}
              {isShopLine && (
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">Mode</span>
                  <Select value={config.mode} disabled={isBusy("mode")} onValueChange={v => {
                    if (v === config.mode) return
                    const modeLabel = v === "shop" ? "Shop USSD" : "Main USSD"
                    const billing = v === "shop"
                      ? " In shop mode callers must enter a shop code first (customer sessions are free)."
                      : ""
                    if (!window.confirm(`Switch the Hubtel code to ${modeLabel}?${billing} Calls already in progress keep the mode they started with; new dials use ${modeLabel}.`)) return
                    save({ mode: v }, "mode")
                  }}>
                    <SelectTrigger className="w-48" aria-label="Hubtel USSD mode"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="main">Main USSD</SelectItem>
                      <SelectItem value="shop">Shop USSD (shop code first)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )}
              {isShopLine && config.mode === "shop" && (
                <p className="text-xs text-muted-foreground">
                  Shop mode: callers enter a shop code first (customer sessions are free). Services follow the shop&apos;s catalogue and the toggles below. AFA is not
                  offered in shop mode. Calls already in progress keep the mode they started with.
                </p>
              )}
              <div className="divide-y rounded-lg border">
                {SERVICES.map(s => {
                  // The shop menu has no AFA: its toggle does nothing in shop mode.
                  const deadInShop = config.mode === "shop" && s.key === "afa"
                  return (
                    <div key={s.key} className="flex items-center justify-between p-3">
                      <span className="text-sm">
                        {s.label}{!IMPLEMENTED_SERVICES[s.key] && <Badge variant="outline" className="ml-2">not built yet</Badge>}
                        {deadInShop && <span className="ml-2 text-xs text-muted-foreground">AFA is not offered in shop mode</span>}
                      </span>
                      <Switch checked={config.visibility[s.key]} disabled={isBusy(s.key) || deadInShop} aria-label={`Toggle ${s.label}`}
                        onCheckedChange={v => save({ visibility: { [s.key]: v } }, s.key)} />
                    </div>
                  )
                })}
              </div>
              <p className="text-xs text-muted-foreground">
                Cashback menus: shown only when Commission Cashback is on for bots (and the matching group) as well as here.
              </p>
              <div className="divide-y rounded-lg border">
                {CASHBACK_SERVICES.map(s => (
                  <div key={s.key} className="flex items-center justify-between p-3">
                    <span className="text-sm">{s.label}</span>
                    <Switch checked={config.visibility[s.key] !== false} disabled={isBusy(s.key)} aria-label={`Toggle ${s.label}`}
                      onCheckedChange={v => save({ visibility: { [s.key]: v } }, s.key)} />
                  </div>
                ))}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Brand name</CardTitle>
            <CardDescription>
              The name callers see on the Hubtel screens: the welcome line (unless a custom welcome is set below), the
              exit message (&quot;Thank you for using {previewBrand}.&quot;) and the Check Results &quot;create an
              account&quot; message. SMS texts sent by shared services are not affected. Applies immediately.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {!config ? <p className="text-sm text-muted-foreground">Loading...</p> : (
              <>
                <div className="space-y-1">
                  <Input
                    value={brandDraft}
                    onChange={e => setBrandDraft(e.target.value)}
                    maxLength={BRAND_MAX}
                    placeholder={DEFAULT_BRAND}
                    aria-label="Brand name"
                    aria-invalid={!brandCheck.ok}
                    aria-describedby={`hubtel-${line}-brand-help`}
                  />
                  <div id={`hubtel-${line}-brand-help`} className="flex items-start justify-between gap-3 text-xs">
                    <span className={brandCheck.ok ? "text-muted-foreground" : "text-destructive"}>
                      {brandCheck.ok ? "1-30 plain characters (letters, numbers, spaces, basic punctuation), one line." : brandCheck.error}
                    </span>
                    <span className="shrink-0 tabular-nums text-muted-foreground">{brandDraft.length}/{BRAND_MAX}</span>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    disabled={isBusy("brand") || !brandCheck.ok || brandUnchanged}
                    onClick={() => { if (brandCheck.ok) save({ brandName: brandCheck.value }, "brand") }}
                  >
                    {isBusy("brand") ? "Saving..." : "Save"}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={isBusy("brand") || (savedBrand === DEFAULT_BRAND && brandDraft === DEFAULT_BRAND)}
                    onClick={() => {
                      // Already the default on the server: just discard the local edit.
                      if (savedBrand === DEFAULT_BRAND) setBrandDraft(DEFAULT_BRAND)
                      else save({ brandName: "" }, "brand")
                    }}
                  >
                    Reset to default
                  </Button>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Welcome message</CardTitle>
            <CardDescription>
              {isShopLine
                ? "The first line callers see: on the main menu (main mode) and on the shop-code prompt (shop mode). Applies to new dials immediately."
                : "The first line callers see on the main menu. Applies to new dials immediately."}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {!config ? <p className="text-sm text-muted-foreground">Loading...</p> : (
              <>
                <div className="flex items-center gap-2 text-xs">
                  <Badge variant={config.welcomeCustom ? "default" : "outline"}>{config.welcomeCustom ? "Custom" : "From brand name"}</Badge>
                  <span className="text-muted-foreground">Leave blank to use &apos;{derivedWelcome(previewBrand)}&apos;.</span>
                </div>
                <div className="space-y-1">
                  <Input
                    value={welcomeDraft}
                    onChange={e => setWelcomeDraft(e.target.value)}
                    maxLength={WELCOME_MAX}
                    placeholder={derivedWelcome(previewBrand)}
                    aria-label="Welcome message"
                    aria-invalid={!welcomeValid}
                    aria-describedby={`hubtel-${line}-welcome-help`}
                  />
                  <div id={`hubtel-${line}-welcome-help`} className="flex items-start justify-between gap-3 text-xs">
                    <span className={welcomeValid ? "text-muted-foreground" : "text-destructive"}>
                      {welcomeValid || welcomeCheck.ok
                        ? "1-60 plain characters (letters, numbers, spaces, basic punctuation), one line."
                        : welcomeCheck.error}
                    </span>
                    <span className="shrink-0 tabular-nums text-muted-foreground">{welcomeDraft.length}/{WELCOME_MAX}</span>
                  </div>
                </div>
                <div className="rounded-lg border bg-muted/40 p-3">
                  <div className="mb-1 text-xs text-muted-foreground">Preview</div>
                  <pre className="whitespace-pre-wrap break-words font-mono text-sm">
                    {`${previewWelcome}\n${config.mode === "shop" ? "Enter shop code:" : "1. Internet Bundles\n..."}`}
                  </pre>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    disabled={isBusy("welcome") || !welcomeValid || welcomeUnchanged}
                    onClick={() => save({ welcome: welcomeBlank ? "" : welcomeDraft.trim() }, "welcome")}
                  >
                    {isBusy("welcome") ? "Saving..." : "Save"}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={isBusy("welcome") || (!config.welcomeCustom && welcomeBlank)}
                    onClick={() => {
                      // Not customised on the server: just discard the local edit.
                      if (!config.welcomeCustom) setWelcomeDraft("")
                      else save({ welcome: "" }, "welcome")
                    }}
                  >
                    Reset to default
                  </Button>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
