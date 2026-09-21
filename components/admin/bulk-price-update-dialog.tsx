"use client"

import { useState } from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Checkbox } from "@/components/ui/checkbox"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Badge } from "@/components/ui/badge"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"
import { adminPackageService } from "@/lib/admin-service"
import {
  computePackagePriceUpdate,
  type BulkPriceUpdates,
  type PriceMode,
  type PackagePriceResult,
  type SkipReason,
} from "@/lib/bulk-package-pricing"

interface SelectedPackage {
  id: string
  network: string
  size: string
  price: number
  dealer_price?: number | null
}

interface BulkPriceUpdateDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  selectedPackages: SelectedPackage[]
  onApplied: () => void
}

const SKIP_REASON_LABEL: Record<SkipReason | "write_failed", string> = {
  non_positive_price: "New price would be zero or negative",
  non_positive_dealer_price: "New dealer price would be zero or negative",
  dealer_price_exceeds_price: "New dealer price would exceed the new price",
  non_finite_value: "Entered value is not a valid number",
  write_failed: "Database write failed — the price change may not have been saved",
}

export function BulkPriceUpdateDialog({ open, onOpenChange, selectedPackages, onApplied }: BulkPriceUpdateDialogProps) {
  const [updatePrice, setUpdatePrice] = useState(true)
  const [priceMode, setPriceMode] = useState<PriceMode>("percentage")
  const [priceValue, setPriceValue] = useState("")

  const [updateDealerPrice, setUpdateDealerPrice] = useState(false)
  const [dealerMode, setDealerMode] = useState<PriceMode>("percentage")
  const [dealerValue, setDealerValue] = useState("")

  const [preview, setPreview] = useState<PackagePriceResult[] | null>(null)
  const [applying, setApplying] = useState(false)
  const [results, setResults] = useState<Awaited<ReturnType<typeof adminPackageService.bulkUpdatePrices>> | null>(null)

  const reset = () => {
    setUpdatePrice(true)
    setPriceMode("percentage")
    setPriceValue("")
    setUpdateDealerPrice(false)
    setDealerMode("percentage")
    setDealerValue("")
    setPreview(null)
    setResults(null)
  }

  const buildUpdates = (): BulkPriceUpdates | null => {
    const updates: BulkPriceUpdates = {}
    if (updatePrice) {
      const value = parseFloat(priceValue)
      if (!isFinite(value)) return null
      updates.price = { mode: priceMode, value }
    }
    if (updateDealerPrice) {
      const value = parseFloat(dealerValue)
      if (!isFinite(value)) return null
      updates.dealer_price = { mode: dealerMode, value }
    }
    if (!updates.price && !updates.dealer_price) return null
    return updates
  }

  const handlePreview = () => {
    const updates = buildUpdates()
    if (!updates) {
      toast.error("Enter a valid value for each field you want to update")
      return
    }
    const computed = selectedPackages.map((pkg) =>
      computePackagePriceUpdate(
        { id: pkg.id, price: pkg.price, dealer_price: pkg.dealer_price ?? null, size: pkg.size },
        updates
      )
    )
    setPreview(computed)
  }

  const handleApply = async () => {
    const updates = buildUpdates()
    if (!updates) return
    setApplying(true)
    try {
      const data = await adminPackageService.bulkUpdatePrices(selectedPackages.map((p) => p.id), updates)
      setResults(data)
      onApplied()
    } catch (error: any) {
      toast.error(error?.message || "Failed to apply bulk price update")
    } finally {
      setApplying(false)
    }
  }

  const validPreviewCount = preview?.filter((r) => r.skip_reason === null).length ?? 0
  const packageById = new Map(selectedPackages.map((p) => [p.id, p]))

  const handleOpenChange = (next: boolean) => {
    if (!next && applying) return
    if (!next) reset()
    onOpenChange(next)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Bulk Update Prices</DialogTitle>
          <DialogDescription>
            {selectedPackages.length} package{selectedPackages.length === 1 ? "" : "s"} selected
          </DialogDescription>
        </DialogHeader>

        {results ? (
          <div className="space-y-3">
            <div className="flex gap-4 text-sm">
              <span className="text-success font-semibold">✓ {results.updated.length} updated</span>
              <span className="text-destructive font-semibold">✗ {results.skipped.length} skipped</span>
            </div>
            {results.not_found.length > 0 && (
              <p className="text-xs text-muted-foreground">
                {results.not_found.length} package(s) in your selection could no longer be found and were skipped.
              </p>
            )}
            {results.skipped.length > 0 && (
              <div className="space-y-2">
                {results.skipped.map((r) => (
                  <div key={r.id} className="p-2 rounded-lg text-xs border border-destructive/20 bg-destructive/5">
                    <span className="font-semibold">{packageById.get(r.id)?.network} {packageById.get(r.id)?.size}GB</span>
                    {" — "}
                    {SKIP_REASON_LABEL[r.skip_reason] ?? r.skip_reason}
                  </div>
                ))}
              </div>
            )}
            <Button onClick={() => handleOpenChange(false)} className="w-full">Close</Button>
          </div>
        ) : (
          <div className="space-y-4">
            {/* Price field */}
            <div className="border border-border rounded-lg p-3 space-y-3">
              <div className="flex items-center gap-2">
                <Checkbox
                  id="update-price-checkbox"
                  checked={updatePrice}
                  onCheckedChange={(v) => {
                    setUpdatePrice(v === true)
                    setPreview(null)
                  }}
                />
                <Label htmlFor="update-price-checkbox">Update user price</Label>
              </div>
              {updatePrice && (
                <div className="pl-6 space-y-2">
                  <RadioGroup
                    value={priceMode}
                    onValueChange={(v) => {
                      setPriceMode(v as PriceMode)
                      setPreview(null)
                    }}
                    className="flex gap-4"
                  >
                    <div className="flex items-center gap-2">
                      <RadioGroupItem value="percentage" id="price-mode-pct" />
                      <Label htmlFor="price-mode-pct">Percentage adjustment</Label>
                    </div>
                    <div className="flex items-center gap-2">
                      <RadioGroupItem value="per_gb" id="price-mode-gb" />
                      <Label htmlFor="price-mode-gb">Set per-GB rate</Label>
                    </div>
                  </RadioGroup>
                  <Input
                    type="number"
                    step="0.01"
                    placeholder={priceMode === "percentage" ? "e.g. 10 or -5" : "e.g. 4.50"}
                    value={priceValue}
                    onChange={(e) => {
                      setPriceValue(e.target.value)
                      setPreview(null)
                    }}
                  />
                </div>
              )}
            </div>

            {/* Dealer price field */}
            <div className="border border-border rounded-lg p-3 space-y-3">
              <div className="flex items-center gap-2">
                <Checkbox
                  id="update-dealer-price-checkbox"
                  checked={updateDealerPrice}
                  onCheckedChange={(v) => {
                    setUpdateDealerPrice(v === true)
                    setPreview(null)
                  }}
                />
                <Label htmlFor="update-dealer-price-checkbox">Update dealer price</Label>
              </div>
              {updateDealerPrice && (
                <div className="pl-6 space-y-2">
                  <RadioGroup
                    value={dealerMode}
                    onValueChange={(v) => {
                      setDealerMode(v as PriceMode)
                      setPreview(null)
                    }}
                    className="flex gap-4"
                  >
                    <div className="flex items-center gap-2">
                      <RadioGroupItem value="percentage" id="dealer-mode-pct" />
                      <Label htmlFor="dealer-mode-pct">Percentage adjustment</Label>
                    </div>
                    <div className="flex items-center gap-2">
                      <RadioGroupItem value="per_gb" id="dealer-mode-gb" />
                      <Label htmlFor="dealer-mode-gb">Set per-GB rate</Label>
                    </div>
                  </RadioGroup>
                  <Input
                    type="number"
                    step="0.01"
                    placeholder={dealerMode === "percentage" ? "e.g. 10 or -5" : "e.g. 4.00"}
                    value={dealerValue}
                    onChange={(e) => {
                      setDealerValue(e.target.value)
                      setPreview(null)
                    }}
                  />
                </div>
              )}
            </div>

            <Button variant="outline" onClick={handlePreview} className="w-full">Preview</Button>

            {preview && (
              <div className="space-y-2">
                <div className="overflow-x-auto border border-border rounded-lg">
                  <table className="w-full text-xs">
                    <thead className="bg-muted/40">
                      <tr>
                        <th className="px-3 py-2 text-left">Package</th>
                        <th className="px-3 py-2 text-left">Old Price</th>
                        <th className="px-3 py-2 text-left">New Price</th>
                        <th className="px-3 py-2 text-left">Old Dealer</th>
                        <th className="px-3 py-2 text-left">New Dealer</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {preview.map((r) => {
                        const pkg = packageById.get(r.id)
                        return (
                          <tr key={r.id} className={r.skip_reason ? "bg-destructive/5" : ""}>
                            <td className="px-3 py-2">{pkg?.network} {pkg?.size}GB</td>
                            <td className="px-3 py-2">GHS {r.old_price.toFixed(2)}</td>
                            <td className="px-3 py-2 font-semibold">
                              {r.skip_reason ? (
                                <Badge className="bg-destructive/15 text-destructive">skipped</Badge>
                              ) : (
                                `GHS ${r.new_price.toFixed(2)}`
                              )}
                            </td>
                            <td className="px-3 py-2">{r.old_dealer_price != null ? `GHS ${r.old_dealer_price.toFixed(2)}` : "-"}</td>
                            <td className="px-3 py-2">{!r.skip_reason && r.new_dealer_price != null ? `GHS ${r.new_dealer_price.toFixed(2)}` : "-"}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
                {preview.some((r) => r.skip_reason) && (
                  <p className="text-xs text-muted-foreground">
                    Rows marked "skipped" will not be changed — reasons are shown after you apply.
                  </p>
                )}
              </div>
            )}

            <DialogFooter>
              <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={applying}>Cancel</Button>
              <Button onClick={handleApply} disabled={!preview || validPreviewCount === 0 || applying}>
                {applying ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Applying...</> : `Confirm & Apply (${validPreviewCount})`}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
