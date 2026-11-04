"use client"

import { useEffect, useState } from "react"
import { DollarSign, Loader2, Save } from "lucide-react"
import { toast } from "sonner"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import type { GatewayConfig } from "@/lib/payment-gateway/config"
import { putGatewayConfig, putGatewaySettings, type GatewaySettingsValues, type HubtelReadiness } from "../_lib/api"

interface Props {
  savedConfig: GatewayConfig
  hubtel: HubtelReadiness
  paystackFeePercentage: number
  walletTopupFeePercentage: number
  onConfigSaved: (config: GatewayConfig) => void
  onSettingsSaved: (values: Partial<GatewaySettingsValues>) => void
}

const num = (v: number) => (Number.isFinite(v) ? v : 0)

export function GatewayFeesCard({
  savedConfig,
  hubtel,
  paystackFeePercentage,
  walletTopupFeePercentage,
  onConfigSaved,
  onSettingsSaved,
}: Props) {
  const [paystackFee, setPaystackFee] = useState<number>(paystackFeePercentage)
  const [hubtelFee, setHubtelFee] = useState<number>(savedConfig.hubtelFeePercent)
  const [saving, setSaving] = useState(false)

  useEffect(() => setPaystackFee(paystackFeePercentage), [paystackFeePercentage])
  useEffect(() => setHubtelFee(savedConfig.hubtelFeePercent), [savedConfig.hubtelFeePercent])

  const handleSave = async () => {
    if (!Number.isFinite(hubtelFee)) {
      toast.error("Enter a valid Hubtel fee %")
      return
    }
    setSaving(true)
    try {
      await putGatewaySettings({ paystack_fee_percentage: paystackFee }, ["paystack_fee_percentage"])
      onSettingsSaved({ paystack_fee_percentage: paystackFee })
      if (hubtelFee !== savedConfig.hubtelFeePercent) {
        // Only hubtelFeePercent changes; surfaces stay as last saved.
        const config = await putGatewayConfig({ ...savedConfig, hubtelFeePercent: hubtelFee })
        onConfigSaved(config)
      }
      toast.success("Gateway fees saved")
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to save gateway fees")
    } finally {
      setSaving(false)
    }
  }

  const p = num(paystackFee)
  const w = num(walletTopupFeePercentage)

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <DollarSign className="h-5 w-5 text-success" />
          Gateway fees &amp; status
        </CardTitle>
        <CardDescription>Fee percentage charged per gateway, and whether each gateway can take payments.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border p-3 text-sm">
          <span className="font-medium text-foreground">Paystack</span>
          <Badge className="bg-success text-primary-foreground">Live</Badge>
          <span className="ml-2 font-medium text-foreground">Hubtel</span>
          {hubtel.ready ? (
            <Badge className="bg-success text-primary-foreground">Ready</Badge>
          ) : (
            <Badge variant="outline" className="border-warning text-warning">Not ready</Badge>
          )}
          {!hubtel.ready && hubtel.missing.length > 0 && (
            <p className="w-full text-xs text-muted-foreground">Missing: {hubtel.missing.join(", ")}</p>
          )}
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <Label htmlFor="paystackFee" className="text-sm font-medium">Paystack fee %</Label>
            <p className="mt-1 mb-2 text-xs text-muted-foreground">Fee charged for Paystack payments (e.g., 3 for 3%)</p>
            <div className="flex items-center gap-2">
              <Input
                id="paystackFee"
                type="number"
                min="0"
                max="100"
                step="0.01"
                value={Number.isNaN(paystackFee) ? "" : paystackFee}
                onChange={(e) => setPaystackFee(parseFloat(e.target.value))}
                placeholder="3.0"
              />
              <span className="text-sm text-muted-foreground">%</span>
            </div>
          </div>
          <div>
            <Label htmlFor="hubtelFee" className="text-sm font-medium">Hubtel fee %</Label>
            <p className="mt-1 mb-2 text-xs text-muted-foreground">Fee charged for Hubtel payments once Hubtel ships</p>
            <div className="flex items-center gap-2">
              <Input
                id="hubtelFee"
                type="number"
                min="0"
                max="100"
                step="0.01"
                value={Number.isNaN(hubtelFee) ? "" : hubtelFee}
                onChange={(e) => setHubtelFee(parseFloat(e.target.value))}
                placeholder="0"
              />
              <span className="text-sm text-muted-foreground">%</span>
            </div>
          </div>
        </div>

        <div className="rounded-lg border border-primary/20 bg-primary/5 p-4">
          <h4 className="mb-2 text-sm font-semibold text-primary">Top-up Preview (GHS 100)</h4>
          <div className="space-y-1 text-sm">
            <div className="flex justify-between">
              <span className="text-primary">Amount to top up:</span>
              <span className="font-medium text-primary">GHS 100.00</span>
            </div>
            <div className="flex justify-between">
              <span className="text-primary">Paystack fee ({p}%):</span>
              <span className="font-medium text-primary">GHS {(100 * p / 100).toFixed(2)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-primary">Wallet topup fee ({w}%):</span>
              <span className="font-medium text-primary">GHS {(100 * w / 100).toFixed(2)}</span>
            </div>
            <div className="flex justify-between border-t border-primary/20 pt-1">
              <span className="font-semibold text-primary">Total charge:</span>
              <span className="font-bold text-primary">GHS {(100 + (100 * p / 100) + (100 * w / 100)).toFixed(2)}</span>
            </div>
          </div>
        </div>

        <Button onClick={handleSave} disabled={saving} className="w-full sm:w-auto">
          {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
          Save fees
        </Button>
      </CardContent>
    </Card>
  )
}
