"use client"

import { useEffect, useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Switch } from "@/components/ui/switch"
import { Eye, Loader2 } from "lucide-react"
import { toast } from "sonner"
import { adminUssdService } from "@/lib/admin-service"
import type { UssdServiceVisibility } from "@/lib/ussd-service-visibility"

const SERVICE_ROWS: { key: keyof UssdServiceVisibility; label: string }[] = [
  { key: "data", label: "Data Bundle" },
  { key: "afa", label: "AFA Registration" },
  { key: "airtime", label: "Buy Airtime" },
  { key: "resultsChecker", label: "Results Checker" },
]

export function UssdServiceVisibilityCard() {
  const [visibility, setVisibility] = useState<UssdServiceVisibility | null>(null)
  const [loading, setLoading] = useState(true)
  const [updatingService, setUpdatingService] = useState<string | null>(null)

  const fetchVisibility = async () => {
    setLoading(true)
    try {
      const data = await adminUssdService.getServiceVisibility()
      setVisibility(data)
    } catch (error: any) {
      toast.error(error?.message || "Failed to load USSD menu service visibility")
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchVisibility()
  }, [])

  // No confirmation dialog — unlike network stock (which disables real
  // inventory), toggling a menu-visibility switch has zero data-mutation
  // side effects. Apply immediately in both directions.
  const handleToggle = async (service: keyof UssdServiceVisibility, checked: boolean) => {
    setUpdatingService(service)
    try {
      const result = await adminUssdService.setServiceVisibility(service, checked)
      setVisibility(result.status)
      const label = SERVICE_ROWS.find((r) => r.key === service)?.label ?? service
      toast.success(`${label} ${checked ? "shown" : "hidden"} on the USSD menu`)
    } catch (error: any) {
      toast.error(error?.message || "Failed to update service visibility")
    } finally {
      setUpdatingService(null)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Eye className="w-4 h-4" /> USSD Menu Services</CardTitle>
        <CardDescription>
          Hide a service from the top-level USSD menu (main dial-code menu and shop-code storefront) without disabling it anywhere else.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {loading || !visibility ? (
          <div className="p-6 text-center text-sm text-muted-foreground">Loading...</div>
        ) : (
          <div className="divide-y rounded-lg border">
            {SERVICE_ROWS.map(({ key, label }) => {
              const isUpdating = updatingService === key
              return (
                <div key={key} className="flex items-center justify-between p-3">
                  <span className="text-sm font-medium">{label}</span>
                  <div className="flex items-center gap-2">
                    {isUpdating && <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />}
                    <Switch
                      checked={visibility[key]}
                      disabled={isUpdating}
                      aria-label={`Toggle ${label} on USSD menu`}
                      onCheckedChange={(checked) => handleToggle(key, checked)}
                    />
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
