"use client"
import Link from "next/link"
import { useRef, useState } from "react"
import { api, type SettingsData } from "../_lib/api"
import { useLoad } from "../_lib/useLoad"
import { providerLabel } from "../_lib/view"
import { ErrorBox, LoadingRows } from "./ui-bits"
import { ApiLimitSection, BusinessListsSection, CapsSection, HubtelSection, ModerationSection, PlatformKeywordsSection, PricingSection, RolesSection, SenderPoolSection } from "./SettingsSections"

export default function SettingsTab({ provider }: { provider: string }) {
  const lastLoadOk = useRef(false)
  const { data, error, loading, reload } = useLoad<SettingsData>(async () => {
    const r = await api<SettingsData>("/api/admin/sms-platform/settings")
    lastLoadOk.current = r.success
    return r
  }, [])
  // The newest server copy handed back by a save (null once a reload has superseded it).
  const [fresh, setFresh] = useState<SettingsData | null>(null)
  // Per-section revision: a section re-mounts (re-seeding its draft from the server) ONLY after its own
  // successful save, so unsaved edits in the other sections survive.
  const [revs, setRevs] = useState<Record<string, number>>({})
  const bump = (section: string) => setRevs((r) => ({ ...r, [section]: (r[section] ?? 0) + 1 }))
  const saved = (section: string) => async (next: SettingsData | null) => {
    if (next) { setFresh(next); bump(section); return }
    // Saved, but the server could not re-read: refetch ourselves. Only re-seed the section if the refetch worked.
    await reload()
    if (lastLoadOk.current) { setFresh(null); bump(section) }
  }

  const d = fresh ?? data
  if (loading && !d) return <LoadingRows rows={4} />
  if (error && !d) return <ErrorBox message={error} onRetry={() => void reload()} />
  if (!d) return null
  const s = d.settings
  const k = (section: string) => `${section}-${revs[section] ?? 0}`
  return (
    <div className="space-y-4">
      <div className="clay-inset rounded-2xl px-4 py-3 text-sm">
        <p><span className="font-medium">Provider:</span> {providerLabel(provider)} is the active SMS provider. Change providers (with the Hubtel readiness checks) in <Link className="text-primary hover:underline" href="/admin/sms-centre">SMS Centre → Providers</Link>.</p>
        <p className="mt-1 text-muted-foreground"><span className="font-medium text-foreground">Enforcement:</span> {s.policyEnforced ? "On" : "Record-only"} — caps, keywords, flags and holds are measured but not enforced until Phase 3. The master switch (page header) is enforced now.</p>
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <SenderPoolSection key={k("sender_pool")} s={s} onSaved={saved("sender_pool")} />
        <RolesSection key={k("roles")} s={s} onSaved={saved("roles")} />
        <CapsSection key={k("caps")} s={s} onSaved={saved("caps")} />
        <PlatformKeywordsSection key={k("platform_keywords")} s={s} onSaved={saved("platform_keywords")} />
        <BusinessListsSection key={k("business_lists")} s={s} onSaved={saved("business_lists")} />
        <ModerationSection key={k("moderation")} s={s} onSaved={saved("moderation")} />
        <ApiLimitSection key={k("api_limit")} s={s} onSaved={saved("api_limit")} />
        <PricingSection key={k("pricing")} d={d} onSaved={saved("pricing")} />
        <HubtelSection key={k("hubtel")} s={s} onSaved={saved("hubtel")} />
      </div>
    </div>
  )
}
