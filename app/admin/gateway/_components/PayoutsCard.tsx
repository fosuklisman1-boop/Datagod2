"use client"

import { useEffect, useState } from "react"
import { Loader2, Save, Wallet } from "lucide-react"
import { toast } from "sonner"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { putGatewaySettings, type GatewaySettingsValues } from "../_lib/api"

const PAYOUT_KEYS = ["withdrawal_fee_percentage", "withdrawal_fee_minimum", "minimum_withdrawal_amount"] as const

interface Props {
  withdrawalFeePercentage: number
  withdrawalFeeMinimum: number
  minimumWithdrawalAmount: number
  onSettingsSaved: (values: Partial<GatewaySettingsValues>) => void
}

const num = (v: number) => (Number.isFinite(v) ? v : 0)

export function PayoutsCard({ withdrawalFeePercentage, withdrawalFeeMinimum, minimumWithdrawalAmount, onSettingsSaved }: Props) {
  const [feePct, setFeePct] = useState<number>(withdrawalFeePercentage)
  const [feeMin, setFeeMin] = useState<number>(withdrawalFeeMinimum)
  const [minAmount, setMinAmount] = useState<number>(minimumWithdrawalAmount)
  const [saving, setSaving] = useState(false)

  useEffect(() => setFeePct(withdrawalFeePercentage), [withdrawalFeePercentage])
  useEffect(() => setFeeMin(withdrawalFeeMinimum), [withdrawalFeeMinimum])
  useEffect(() => setMinAmount(minimumWithdrawalAmount), [minimumWithdrawalAmount])

  const handleSave = async () => {
    setSaving(true)
    try {
      const values = {
        withdrawal_fee_percentage: feePct,
        withdrawal_fee_minimum: feeMin,
        minimum_withdrawal_amount: minAmount,
      }
      await putGatewaySettings(values, PAYOUT_KEYS)
      onSettingsSaved(values)
      toast.success("Payout settings saved")
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to save payout settings")
    } finally {
      setSaving(false)
    }
  }

  const fee = Math.max(100 * num(feePct) / 100, num(feeMin))

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Wallet className="h-5 w-5 text-primary" />
          Payouts
        </CardTitle>
        <CardDescription>Shop-owner withdrawal fee and limits.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <Label htmlFor="withdrawalFee" className="text-sm font-medium">Withdrawal Fee Percentage</Label>
          <p className="mt-1 mb-2 text-xs text-muted-foreground">Fee deducted from withdrawal requests (e.g., 5 for 5%)</p>
          <div className="flex items-center gap-2">
            <Input
              id="withdrawalFee"
              type="number"
              min="0"
              max="100"
              step="0.01"
              value={Number.isNaN(feePct) ? "" : feePct}
              onChange={(e) => setFeePct(parseFloat(e.target.value))}
              placeholder="0"
            />
            <span className="text-sm text-muted-foreground">%</span>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <Label htmlFor="withdrawalFeeMinimum" className="text-sm font-medium">Withdrawal Fee Minimum (GHS)</Label>
            <p className="mt-1 mb-2 text-xs text-muted-foreground">
              The fee never goes below this amount, even if the percentage above would compute less. Set to 0 for no floor.
            </p>
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">GHS</span>
              <Input
                id="withdrawalFeeMinimum"
                type="number"
                min="0"
                step="0.01"
                value={Number.isNaN(feeMin) ? "" : feeMin}
                onChange={(e) => setFeeMin(parseFloat(e.target.value))}
                placeholder="0"
              />
            </div>
          </div>
          <div>
            <Label htmlFor="minimumWithdrawalAmount" className="text-sm font-medium">Minimum Withdrawal Amount (GHS)</Label>
            <p className="mt-1 mb-2 text-xs text-muted-foreground">The smallest amount a shop owner may request to withdraw.</p>
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">GHS</span>
              <Input
                id="minimumWithdrawalAmount"
                type="number"
                min="0"
                step="0.01"
                value={Number.isNaN(minAmount) ? "" : minAmount}
                onChange={(e) => setMinAmount(parseFloat(e.target.value))}
                placeholder="5"
              />
            </div>
          </div>
        </div>

        <div className="rounded-lg border border-primary/20 bg-primary/5 p-4">
          <h4 className="mb-2 text-sm font-semibold text-primary">Withdrawal Preview (GHS 100 Requested)</h4>
          <div className="space-y-1 text-sm">
            <div className="flex justify-between">
              <span className="text-primary">Requested amount:</span>
              <span className="font-medium text-primary">GHS 100.00</span>
            </div>
            <div className="flex justify-between gap-2">
              <span className="text-primary">
                Withdrawal fee (max of {num(feePct)}% or GHS {num(feeMin).toFixed(2)}):
              </span>
              <span className="font-medium text-warning">-GHS {fee.toFixed(2)}</span>
            </div>
            <div className="flex justify-between border-t border-primary/20 pt-1">
              <span className="font-semibold text-primary">Shop receives:</span>
              <span className="font-bold text-success">GHS {(100 - fee).toFixed(2)}</span>
            </div>
          </div>
        </div>

        <Button onClick={handleSave} disabled={saving} className="w-full sm:w-auto">
          {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
          Save payouts
        </Button>
      </CardContent>
    </Card>
  )
}
