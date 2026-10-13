"use client"
import { useState } from "react"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { api, type SettingsData } from "../_lib/api"
import { ChipsInput } from "./ui-bits"

type S = SettingsData["settings"]
type Saved = (data: SettingsData | null) => void | Promise<void>

const NONE = "__none__"

/** "Platform sender names": the names Hubtel sends may use when no customer sender is chosen, plus which one is the default. */
export function PlatformSendersSection({ s, onSaved }: { s: S; onSaved: Saved }) {
  const [base] = useState(() => JSON.stringify({ names: s.platformSenders, def: s.platformDefaultSender ?? "" }))
  const [names, setNames] = useState<string[]>(s.platformSenders)
  const [def, setDef] = useState<string>(s.platformDefaultSender ?? "")
  const [saving, setSaving] = useState(false)
  const dirty = JSON.stringify({ names, def }) !== base
  const defMissing = def !== "" && !names.includes(def)

  async function save() {
    if (saving) return
    setSaving(true)
    try {
      const res = await api<SettingsData | null>("/api/admin/sms-platform/settings", {
        method: "PATCH",
        body: JSON.stringify({ section: "platform_senders", values: { platformSenders: names, platformDefaultSender: def || null } }),
      })
      if (res.success) { toast.success("Saved"); await onSaved(res.data ?? null) }
      else toast.error(res.error ?? "Could not save")
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save")
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card className="clay min-w-0 border-0 py-0">
      <CardHeader className="pb-2 pt-4">
        <CardTitle className="text-base">Platform sender names</CardTitle>
        <CardDescription>
          3–11 letters/numbers. Hubtel accepts any name up to 11 characters, but carriers can filter names — test delivery on MTN, Telecel and AT before making a name the default.
          Used for Hubtel sends only; Moolre keeps its own registered name.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 pb-4">
        <ChipsInput value={names} onChange={setNames} placeholder="e.g. CLINGDTGOD2" transform={(x) => x.toUpperCase()} />
        <label className="block min-w-0 space-y-1">
          <span className="text-sm font-medium">Default</span>
          <Select value={def === "" ? NONE : def} onValueChange={(v) => setDef(v === NONE ? "" : v)}>
            <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>None (use the built-in name)</SelectItem>
              {names.map((n) => <SelectItem key={n} value={n}>{n}</SelectItem>)}
              {defMissing && <SelectItem value={def}>{def} (removed from list)</SelectItem>}
            </SelectContent>
          </Select>
        </label>
        {defMissing && <p className="text-xs text-amber-700 dark:text-amber-300">The default &quot;{def}&quot; is no longer in the list — choose another default (or None) before saving.</p>}
        <div className="flex flex-wrap items-center gap-3">
          <Button size="sm" disabled={saving || !dirty || defMissing} onClick={() => void save()}>{saving && <Loader2 className="size-4 animate-spin" />}Save</Button>
          {dirty && !saving && <span className="text-xs text-amber-700 dark:text-amber-300">Unsaved changes</span>}
        </div>
      </CardContent>
    </Card>
  )
}
