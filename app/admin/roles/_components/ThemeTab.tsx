"use client"

import { useEffect, useState } from "react"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { skinFor } from "@/lib/roles/client-rights"
import { sidebarSkinClasses } from "@/lib/sidebar-theme"
import { BADGE_COLORS, ROLE_ICONS } from "@/lib/roles/admin/validate"
import { cn } from "@/lib/utils"
import { adminFetch } from "../_lib/api"
import type { HubRole } from "../_lib/ladder-view"
import { BADGE_CLASSES, RoleBadge } from "./RoleBadge"

interface Props {
  role: HubRole
  onChanged: () => Promise<void> | void
  busy: boolean
  setBusy: (b: boolean) => void
  onError: (e: unknown) => Promise<void> | void
}

type Skin = "default" | "dealer"

export function ThemeTab({ role, onChanged, busy, setBusy, onError }: Props) {
  const savedSkin: Skin = role.theme?.skin === "dealer" ? "dealer" : "default"
  const [skin, setSkin] = useState<Skin>(savedSkin)
  const [color, setColor] = useState<string>(role.badge_color ?? "navy")
  const [icon, setIcon] = useState<string>(role.icon ?? "Star")

  useEffect(() => {
    setSkin(role.theme?.skin === "dealer" ? "dealer" : "default")
    setColor(role.badge_color ?? "navy")
    setIcon(role.icon ?? "Star")
  }, [role.id, role.theme, role.badge_color, role.icon])

  // sub_agent keeps its fixed skin: the server rejects a theme change for it.
  const skinLocked = role.slug === "sub_agent"
  const archived = !!role.archived_at
  const dirty = color !== (role.badge_color ?? "navy") || icon !== (role.icon ?? "Star") || (!skinLocked && skin !== savedSkin)

  // Same skin logic as the real sidebar.
  const c = sidebarSkinClasses(skinFor(false, skin))

  const save = async () => {
    if (busy) return
    setBusy(true)
    try {
      const body: Record<string, unknown> = { badge_color: color, icon }
      if (!skinLocked) body.theme = { skin }
      await adminFetch(`/api/admin/roles/${role.id}`, { method: "PATCH", body })
      toast.success("Saved")
      await onChanged()
    } catch (e) {
      await onError(e)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2 lg:items-start">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Theme</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="space-y-2">
            <Label>Sidebar skin</Label>
            <RadioGroup value={skin} onValueChange={(v) => setSkin(v as Skin)} disabled={skinLocked || archived}>
              {(["default", "dealer"] as const).map((s) => (
                <div key={s} className="flex items-center gap-2">
                  <RadioGroupItem value={s} id={`skin-${s}`} />
                  <Label htmlFor={`skin-${s}`}>{s === "default" ? "Default (light)" : "Dealer (purple)"}</Label>
                </div>
              ))}
            </RadioGroup>
            {skinLocked ? <p className="text-xs text-muted-foreground">The sub-agent skin is fixed.</p> : null}
          </div>

          <div className="space-y-2">
            <Label>Badge colour</Label>
            <div className="flex flex-wrap gap-2">
              {BADGE_COLORS.map((col) => (
                <button
                  key={col}
                  type="button"
                  aria-label={col}
                  aria-pressed={color === col}
                  disabled={archived}
                  onClick={() => setColor(col)}
                  className={cn(
                    "h-8 w-8 rounded-full border-2",
                    BADGE_CLASSES[col],
                    color === col ? "ring-2 ring-primary ring-offset-2" : "",
                  )}
                />
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <Label>Icon</Label>
            <div className="flex flex-wrap gap-2">
              {ROLE_ICONS.map((ic) => (
                <Button
                  key={ic}
                  type="button"
                  size="sm"
                  variant={icon === ic ? "default" : "outline"}
                  aria-pressed={icon === ic}
                  disabled={archived}
                  onClick={() => setIcon(ic)}
                >
                  {ic}
                </Button>
              ))}
            </div>
          </div>

          <Button onClick={save} disabled={busy || archived || !dirty}>
            {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Save
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Preview</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className={cn("w-64 max-w-full p-4", c.container)}>
            <div className={cn("border-b pb-3", c.logoSectionBorder)}>
              <p className="text-sm font-semibold">Datagod</p>
              <p className={cn("text-xs", c.userIdentityText)}>user@example.com</p>
            </div>
            <div className="mt-3 space-y-1 text-sm">
              <div className={cn("rounded-lg px-3 py-2", c.navLinkActive)}>Dashboard</div>
              <div className={cn("rounded-lg px-3 py-2", c.navLinkInactive)}>Orders</div>
            </div>
          </div>
          <RoleBadge name={role.name} color={color} icon={icon} />
        </CardContent>
      </Card>
    </div>
  )
}
