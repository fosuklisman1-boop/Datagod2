"use client"
import { useState, type ReactNode } from "react"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { api, type SettingsData } from "../_lib/api"
import { toNumberOrNaN } from "../_lib/view"
import { ChipsInput } from "./ui-bits"

type S = SettingsData["settings"]
/** Called after THIS section saved. `data` is null when the server saved but could not re-read; the parent refetches. */
type Saved = (data: SettingsData | null) => void | Promise<void>

/** Local draft + dirty flag. The baseline is captured at mount; the parent re-mounts a section (new key) only after that section's own save. */
function useDraft<T>(initial: T) {
  const [base] = useState(() => JSON.stringify(initial))
  const [draft, setDraft] = useState<T>(initial)
  return { draft, setDraft, dirty: JSON.stringify(draft) !== base }
}

function useSectionSave(section: string, onSaved: Saved) {
  const [saving, setSaving] = useState(false)
  async function save(values: unknown) {
    if (saving) return
    setSaving(true)
    try {
      const res = await api<SettingsData | null>("/api/admin/sms-platform/settings", { method: "PATCH", body: JSON.stringify({ section, values }) })
      if (res.success) { toast.success("Saved"); await onSaved(res.data ?? null) }
      else toast.error(res.error ?? "Could not save")
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save")
    } finally {
      setSaving(false)
    }
  }
  return { saving, save }
}

function SectionCard({ title, description, saving, dirty, onSave, children }: {
  title: string; description: string; saving: boolean; dirty: boolean; onSave: () => void; children: ReactNode
}) {
  return (
    <Card className="clay min-w-0 border-0 py-0">
      <CardHeader className="pb-2 pt-4"><CardTitle className="text-base">{title}</CardTitle><CardDescription>{description}</CardDescription></CardHeader>
      <CardContent className="space-y-4 pb-4">
        {children}
        <div className="flex flex-wrap items-center gap-3">
          <Button size="sm" disabled={saving || !dirty} onClick={onSave}>{saving && <Loader2 className="size-4 animate-spin" />}Save</Button>
          {dirty && !saving && <span className="text-xs text-amber-700 dark:text-amber-300">Unsaved changes</span>}
        </div>
      </CardContent>
    </Card>
  )
}

function NumField({ label, value, onChange, hint }: { label: string; value: string; onChange: (v: string) => void; hint?: string }) {
  return (
    <label className="block min-w-0 space-y-1">
      <span className="text-sm font-medium">{label}</span>
      <Input inputMode="decimal" value={value} onChange={(e) => onChange(e.target.value)} />
      {hint && <span className="block text-xs text-muted-foreground">{hint}</span>}
    </label>
  )
}

export function SenderPoolSection({ s, onSaved }: { s: S; onSaved: Saved }) {
  const { saving, save } = useSectionSave("sender_pool", onSaved)
  const { draft: pool, setDraft: setPool, dirty } = useDraft(s.senderPool)
  return (
    <SectionCard title="Sender ID pool" description="Shared names verified businesses can send as, without registering their own (3–11 letters/numbers)." saving={saving} dirty={dirty} onSave={() => void save({ senderPool: pool })}>
      <ChipsInput value={pool} onChange={setPool} placeholder="e.g. DATAGOD, ALERTS" transform={(x) => x.toUpperCase()} />
    </SectionCard>
  )
}

const ROLE_LABELS: Record<string, string> = { shop_owner: "Shop owners", sub_agent: "Sub-agents", dealer: "Dealers without a shop", user: "Other users without a shop" }
export function RolesSection({ s, onSaved }: { s: S; onSaved: Saved }) {
  const { saving, save } = useSectionSave("roles", onSaved)
  const { draft: roles, setDraft: setRoles, dirty } = useDraft([...s.allowedRoles].sort())
  // Kept sorted so un-ticking then re-ticking a role doesn't read as a change.
  const set = (r: string, on: boolean) => setRoles((cur) => (on ? (cur.includes(r) ? cur : [...cur, r].sort()) : cur.filter((x) => x !== r)))
  return (
    <SectionCard title="Allowed roles" description="Who can use SMS. Admins always can. Removing a role doesn't delete existing accounts." saving={saving} dirty={dirty} onSave={() => void save({ allowedRoles: roles })}>
      <div className="grid gap-2 sm:grid-cols-2">
        {Object.entries(ROLE_LABELS).map(([r, label]) => (
          <label key={r} className="flex items-center gap-2 text-sm"><Checkbox checked={roles.includes(r)} onCheckedChange={(c) => set(r, c === true)} />{label}</label>
        ))}
      </div>
      {roles.length === 0 && <p className="text-xs text-amber-700 dark:text-amber-300">No roles selected — only admins would be able to use SMS once enforcement is on.</p>}
    </SectionCard>
  )
}

type Mode = "platform" | "business"
type CapKey = "per_send" | "per_hour" | "per_day"
export function CapsSection({ s, onSaved }: { s: S; onSaved: Saved }) {
  const { saving, save } = useSectionSave("caps", onSaved)
  const init = (m: Mode) => ({ per_send: String(s.caps[m].per_send), per_hour: String(s.caps[m].per_hour), per_day: String(s.caps[m].per_day) })
  const { draft: v, setDraft: setV, dirty } = useDraft({ platform: init("platform"), business: init("business") })
  const set = (m: Mode, k: CapKey, val: string) => setV((p) => ({ ...p, [m]: { ...p[m], [k]: val } }))
  const nums = (m: Mode) => ({ per_send: toNumberOrNaN(v[m].per_send), per_hour: toNumberOrNaN(v[m].per_hour), per_day: toNumberOrNaN(v[m].per_day) })
  return (
    <SectionCard title="Sending caps" description="Per-mode limits. Recorded in the policy preview now; enforced from Phase 3." saving={saving} dirty={dirty} onSave={() => void save({ platform: nums("platform"), business: nums("business") })}>
      <div className="grid gap-6 lg:grid-cols-2">
        {(["platform", "business"] as const).map((m) => (
          <div key={m} className="min-w-0 space-y-3">
            <h4 className="text-sm font-semibold capitalize">{m} mode</h4>
            <NumField label="Max recipients per send" value={v[m].per_send} onChange={(x) => set(m, "per_send", x)} hint="Whole number, 1–1,000,000" />
            <NumField label="Max sends per hour" value={v[m].per_hour} onChange={(x) => set(m, "per_hour", x)} hint="Whole number, 1–1,000,000" />
            <NumField label="Max recipients per day" value={v[m].per_day} onChange={(x) => set(m, "per_day", x)} hint="Whole number, 1–100,000,000" />
          </div>
        ))}
      </div>
    </SectionCard>
  )
}

export function PlatformKeywordsSection({ s, onSaved }: { s: S; onSaved: Saved }) {
  const { saving, save } = useSectionSave("platform_keywords", onSaved)
  const { draft: list, setDraft: setList, dirty } = useDraft(s.blockedKeywords)
  return (
    <SectionCard title="Blocked keywords (Platform mode)" description="Messages containing these are blocked and flagged as fraud in Platform mode. Matching ignores case and common disguises like p.i.n." saving={saving} dirty={dirty} onSave={() => void save({ blockedKeywords: list })}>
      <ChipsInput value={list} onChange={setList} placeholder="Add a keyword or phrase" />
    </SectionCard>
  )
}

export function BusinessListsSection({ s, onSaved }: { s: S; onSaved: Saved }) {
  const { saving, save } = useSectionSave("business_lists", onSaved)
  const { draft: d, setDraft: setD, dirty } = useDraft({ blocked: s.businessBlockedKeywords, flagged: s.businessFlaggedKeywords, domains: s.businessAllowedDomains })
  return (
    <SectionCard title="Business mode lists" description="Business accounts may send ordinary links; these lists tighten that." saving={saving} dirty={dirty}
      onSave={() => void save({ businessBlockedKeywords: d.blocked, businessFlaggedKeywords: d.flagged, businessAllowedDomains: d.domains })}>
      <div className="space-y-4">
        <div className="space-y-1"><h4 className="text-sm font-semibold">Blocked keywords</h4><ChipsInput value={d.blocked} onChange={(v) => setD((p) => ({ ...p, blocked: v }))} placeholder="Block messages containing…" /></div>
        <div className="space-y-1"><h4 className="text-sm font-semibold">Flagged keywords</h4><ChipsInput value={d.flagged} onChange={(v) => setD((p) => ({ ...p, flagged: v }))} placeholder="Allow but flag for review…" /></div>
        <div className="space-y-1"><h4 className="text-sm font-semibold">Allowed domains</h4><ChipsInput value={d.domains} onChange={(v) => setD((p) => ({ ...p, domains: v }))} placeholder="e.g. example.com (subdomains included)" /></div>
      </div>
    </SectionCard>
  )
}

export function ModerationSection({ s, onSaved }: { s: S; onSaved: Saved }) {
  const { saving, save } = useSectionSave("moderation", onSaved)
  const { draft: d, setDraft: setD, dirty } = useDraft({ a: String(s.autoSuspendFlags), b: String(s.flagReviewThreshold) })
  return (
    <SectionCard title="Moderation thresholds" description="How many fraud flags suspend an account, and how many open flags put its sends on hold for review." saving={saving} dirty={dirty}
      onSave={() => void save({ autoSuspendFlags: toNumberOrNaN(d.a), flagReviewThreshold: toNumberOrNaN(d.b) })}>
      <div className="grid gap-4 sm:grid-cols-2">
        <NumField label="Auto-suspend after N fraud flags" value={d.a} onChange={(v) => setD((p) => ({ ...p, a: v }))} hint="Whole number, 1–100" />
        <NumField label="Hold for review at N open flags" value={d.b} onChange={(v) => setD((p) => ({ ...p, b: v }))} hint="Whole number, 1–500" />
      </div>
    </SectionCard>
  )
}

export function ApiLimitSection({ s, onSaved }: { s: S; onSaved: Saved }) {
  const { saving, save } = useSectionSave("api_limit", onSaved)
  const { draft: v, setDraft: setV, dirty } = useDraft(String(s.apiRateLimitDefault))
  return (
    <SectionCard title="SMS API rate limit" description="Default requests per minute per account on the public SMS API. Override per account in the Accounts tab." saving={saving} dirty={dirty} onSave={() => void save({ apiRateLimitDefault: toNumberOrNaN(v) })}>
      <NumField label="Requests per minute" value={v} onChange={setV} hint="Whole number, 1–10,000" />
    </SectionCard>
  )
}

export function PricingSection({ d: data, onSaved }: { d: SettingsData; onSaved: Saved }) {
  const { saving, save } = useSectionSave("pricing", onSaved)
  const { draft: d, setDraft: setD, dirty } = useDraft({
    fee: String(data.pricing.activationFee), bonus: String(data.pricing.welcomeBonusCredits), price: String(data.pricing.pricePerCredit),
  })
  return (
    <SectionCard title="Pricing & activation" description="The one-time activation fee, the welcome bonus, and the per-credit price used by quantity purchases." saving={saving} dirty={dirty}
      onSave={() => void save({ activationFee: toNumberOrNaN(d.fee), welcomeBonusCredits: toNumberOrNaN(d.bonus), pricePerCredit: toNumberOrNaN(d.price) })}>
      <div className="grid gap-4 sm:grid-cols-3">
        <NumField label="Activation fee (GH₵)" value={d.fee} onChange={(v) => setD((p) => ({ ...p, fee: v }))} hint="0–10,000 (0 = free)" />
        <NumField label="Welcome bonus (credits)" value={d.bonus} onChange={(v) => setD((p) => ({ ...p, bonus: v }))} hint="Whole number, 1–100,000" />
        <NumField label="Price per credit (GH₵)" value={d.price} onChange={(v) => setD((p) => ({ ...p, price: v }))} hint="0.001–100" />
      </div>
    </SectionCard>
  )
}

export function HubtelSection({ s, onSaved }: { s: S; onSaved: Saved }) {
  const { saving, save } = useSectionSave("hubtel", onSaved)
  const { draft: d, setDraft: setD, dirty } = useDraft({ cost: String(s.hubtelCostPerSms), low: String(s.hubtelLowBalanceGhs) })
  return (
    <SectionCard title="Hubtel supply" description="Used only when Hubtel is the active provider: the per-SMS cost assumed until real rates are seen, and the balance below which admins are alerted." saving={saving} dirty={dirty}
      onSave={() => void save({ hubtelCostPerSms: toNumberOrNaN(d.cost), hubtelLowBalanceGhs: toNumberOrNaN(d.low) })}>
      <div className="grid gap-4 sm:grid-cols-2">
        <NumField label="Assumed cost per SMS (GH₵)" value={d.cost} onChange={(v) => setD((p) => ({ ...p, cost: v }))} hint="0.0001–10" />
        <NumField label="Low-balance alert below (GH₵)" value={d.low} onChange={(v) => setD((p) => ({ ...p, low: v }))} hint="0–1,000,000" />
      </div>
    </SectionCard>
  )
}
