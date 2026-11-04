"use client"

import { useCallback, useEffect, useState } from "react"
import { Loader2, RefreshCw } from "lucide-react"
import { toast } from "sonner"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { PageHeaderBanner } from "@/components/shared/page-header-banner"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { useAdminProtected } from "@/hooks/use-admin"
import type { GatewayConfig } from "@/lib/payment-gateway/config"
import { adminFetch, type GatewaySettingsValues, type HubtelReadiness } from "./_lib/api"
import { GATEWAY_PAGE_SETTINGS_KEYS, pickGatewaySettings } from "./_lib/fee-fields"
import { SurfacesCard } from "./_components/SurfacesCard"
import { GatewayFeesCard } from "./_components/GatewayFeesCard"
import { VerificationCard } from "./_components/VerificationCard"
import { PayoutsCard } from "./_components/PayoutsCard"

interface Loaded {
  config: GatewayConfig
  hubtel: HubtelReadiness
  settings: GatewaySettingsValues
}

export default function AdminGatewayPage() {
  const { isAdmin, loading: adminLoading } = useAdminProtected()
  const [data, setData] = useState<Loaded | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const [gw, settingsRaw] = await Promise.all([
        adminFetch<{ config: GatewayConfig; hubtel: HubtelReadiness }>("/api/admin/gateway"),
        adminFetch<Record<string, unknown>>("/api/admin/settings"),
      ])
      // Never render editable fee inputs on defaults: every value must come from the DB,
      // otherwise a save could overwrite a live value with a placeholder.
      const picked = pickGatewaySettings(settingsRaw)
      const missing = GATEWAY_PAGE_SETTINGS_KEYS.filter((k) => picked[k] === undefined)
      if (missing.length) throw new Error(`Settings missing: ${missing.join(", ")}`)
      setData({ config: gw.config, hubtel: gw.hubtel, settings: picked as GatewaySettingsValues })
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to load payment gateway settings"
      setLoadError(msg)
      toast.error(msg)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (isAdmin) load()
  }, [isAdmin, load])

  const onConfigSaved = useCallback(
    (config: GatewayConfig) => setData((d) => (d ? { ...d, config } : d)),
    [],
  )
  const onSettingsSaved = useCallback(
    (values: Partial<GatewaySettingsValues>) =>
      setData((d) => (d ? { ...d, settings: { ...d.settings, ...values } } : d)),
    [],
  )

  if (adminLoading || !isAdmin) return null

  return (
    <DashboardLayout>
      <div className="bg-muted/40 p-4 md:p-8">
        <div className="mx-auto max-w-2xl lg:max-w-6xl">
          <div className="mb-6">
            <PageHeaderBanner
              title="Payment Gateway"
              subtitle="Gateways, payment modes, fees, verification and payouts"
            />
          </div>

          {loading && !data ? (
            <div className="flex justify-center py-16">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
            </div>
          ) : !data ? (
            <Card>
              <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
                <p className="text-sm text-destructive">{loadError ?? "Failed to load"}</p>
                <p className="text-xs text-muted-foreground">Nothing is editable until the current values load.</p>
                <Button variant="outline" onClick={load}>
                  <RefreshCw className="mr-2 h-4 w-4" /> Retry
                </Button>
              </CardContent>
            </Card>
          ) : (
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-2 lg:items-start">
              <div className="space-y-6">
                <SurfacesCard
                  savedConfig={data.config}
                  hubtel={data.hubtel}
                  walletTopupFeePercentage={data.settings.wallet_topup_fee_percentage}
                  onConfigSaved={onConfigSaved}
                  onSettingsSaved={onSettingsSaved}
                />
              </div>
              <div className="space-y-6">
                <GatewayFeesCard
                  savedConfig={data.config}
                  hubtel={data.hubtel}
                  paystackFeePercentage={data.settings.paystack_fee_percentage}
                  walletTopupFeePercentage={data.settings.wallet_topup_fee_percentage}
                  onConfigSaved={onConfigSaved}
                  onSettingsSaved={onSettingsSaved}
                />
                <VerificationCard />
                <PayoutsCard
                  withdrawalFeePercentage={data.settings.withdrawal_fee_percentage}
                  withdrawalFeeMinimum={data.settings.withdrawal_fee_minimum}
                  minimumWithdrawalAmount={data.settings.minimum_withdrawal_amount}
                  onSettingsSaved={onSettingsSaved}
                />
              </div>
            </div>
          )}
        </div>
      </div>
    </DashboardLayout>
  )
}
