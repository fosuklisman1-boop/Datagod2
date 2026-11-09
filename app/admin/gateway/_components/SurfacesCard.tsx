"use client"

import { useEffect, useState } from "react"
import { Info, Loader2, Route, Save } from "lucide-react"
import { toast } from "sonner"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import {
  DIRECT_ONLY_SURFACES,
  SURFACE_KEYS,
  type FeeBearer,
  type Gateway,
  type GatewayConfig,
  type PaymentMode,
  type SurfaceConfig,
  type SurfaceKey,
} from "@/lib/payment-gateway/config"
import { putGatewayConfig, putGatewaySettings, type GatewaySettingsValues, type HubtelReadiness } from "../_lib/api"

const SURFACE_LABELS: Record<SurfaceKey, { title: string; hint: string }> = {
  wallet_topup: { title: "Wallet top-up", hint: "Dealer wallet funding from the dashboard" },
  storefront: { title: "Storefront checkout", hint: "Guest orders on shop storefronts" },
  dashboard_direct: {
    title: "Dealer upgrade",
    hint: "Dealer upgrade payments today. The results-check service and USSD-shop WhatsApp activation will join this surface later.",
  },
  sms: { title: "SMS credits", hint: "Bulk SMS credit purchases" },
  ussd: { title: "USSD", hint: "USSD menu payments (direct prompt only)" },
  whatsapp: { title: "WhatsApp", hint: "WhatsApp bot payments (direct prompt only)" },
}

interface Props {
  savedConfig: GatewayConfig
  hubtel: HubtelReadiness
  walletTopupFeePercentage: number
  onConfigSaved: (config: GatewayConfig) => void
  onSettingsSaved: (values: Partial<GatewaySettingsValues>) => void
}

export function SurfacesCard({ savedConfig, hubtel, walletTopupFeePercentage, onConfigSaved, onSettingsSaved }: Props) {
  const [surfaces, setSurfaces] = useState(savedConfig.surfaces)
  const [walletFee, setWalletFee] = useState<number>(walletTopupFeePercentage)
  const [saving, setSaving] = useState(false)

  useEffect(() => setSurfaces(savedConfig.surfaces), [savedConfig])
  useEffect(() => setWalletFee(walletTopupFeePercentage), [walletTopupFeePercentage])

  const update = (k: SurfaceKey, patch: Partial<SurfaceConfig>) =>
    setSurfaces((prev) => ({ ...prev, [k]: { ...prev[k], ...patch } }))

  const handleSave = async () => {
    if (!Number.isFinite(walletFee)) {
      toast.error("Enter a valid Extra fee % (0 or more)")
      return
    }
    setSaving(true)
    try {
      // Only this card's section changes; hubtelFeePercent stays as last saved.
      const config = await putGatewayConfig({ ...savedConfig, surfaces })
      onConfigSaved(config)
      await putGatewaySettings({ wallet_topup_fee_percentage: walletFee }, ["wallet_topup_fee_percentage"])
      onSettingsSaved({ wallet_topup_fee_percentage: walletFee })
      toast.success("Payment surfaces saved")
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to save payment surfaces")
    } finally {
      setSaving(false)
    }
  }

  const hubtelReason = hubtel.missing.length ? hubtel.missing.join(", ") : "Hubtel is not ready"

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Route className="h-5 w-5 text-primary" />
          Payment surfaces
        </CardTitle>
        <CardDescription>
          Which gateway and payment mode each place in the app uses. Direct = on-page Mobile Money prompt;
          Checkout = hosted payment page.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {SURFACE_KEYS.map((k) => {
          const s = surfaces[k]
          const directOnly = DIRECT_ONLY_SURFACES.includes(k)
          return (
            <div key={k} className="rounded-lg border border-border p-4 space-y-3">
              <div>
                <p className="font-semibold text-foreground">{SURFACE_LABELS[k].title}</p>
                <p className="text-xs text-muted-foreground">{SURFACE_LABELS[k].hint}</p>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div className="space-y-1">
                  <Label className="flex items-center gap-1 text-xs">
                    Gateway
                    {!hubtel.ready && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button type="button" aria-label="Why is Hubtel unavailable?" className="text-muted-foreground">
                            <Info className="h-3.5 w-3.5" />
                          </button>
                        </TooltipTrigger>
                        <TooltipContent>Hubtel unavailable: {hubtelReason}</TooltipContent>
                      </Tooltip>
                    )}
                  </Label>
                  <Select value={s.gateway} onValueChange={(v) => update(k, { gateway: v as Gateway })}>
                    <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="paystack">Paystack</SelectItem>
                      <SelectItem value="hubtel" disabled={!hubtel.ready} title={hubtel.ready ? undefined : `Unavailable: ${hubtelReason}`}>
                        {hubtel.ready ? "Hubtel" : "Hubtel (not ready)"}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Mode</Label>
                  <Select value={s.mode} onValueChange={(v) => update(k, { mode: v as PaymentMode })}>
                    <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="checkout" disabled={directOnly}>
                        {directOnly ? "Checkout (n/a here)" : "Checkout"}
                      </SelectItem>
                      <SelectItem value="direct">Direct</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-[11px] text-muted-foreground">
                    Checkout = hosted payment page; Direct = MoMo prompt sent straight to the customer&apos;s phone.
                  </p>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Fee bearer</Label>
                  <Select value={s.feeBearer} onValueChange={(v) => update(k, { feeBearer: v as FeeBearer })}>
                    <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="customer">Customer</SelectItem>
                      <SelectItem value="merchant">Merchant</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-[11px] text-muted-foreground">applies once Hubtel ships</p>
                </div>
              </div>
              {k === "wallet_topup" && (
                <div className="space-y-1 sm:max-w-[33%]">
                  <Label htmlFor="walletTopupFee" className="text-xs">Extra fee %</Label>
                  <div className="flex items-center gap-2">
                    <Input
                      id="walletTopupFee"
                      type="number"
                      min="0"
                      max="100"
                      step="0.01"
                      value={Number.isNaN(walletFee) ? "" : walletFee}
                      onChange={(e) => setWalletFee(parseFloat(e.target.value))}
                      placeholder="0"
                    />
                    <span className="text-sm text-muted-foreground">%</span>
                  </div>
                  <p className="text-[11px] text-muted-foreground">Added on top of the gateway fee for top-ups</p>
                </div>
              )}
            </div>
          )
        })}
        <Button onClick={handleSave} disabled={saving} className="w-full sm:w-auto">
          {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
          Save surfaces
        </Button>
      </CardContent>
    </Card>
  )
}
