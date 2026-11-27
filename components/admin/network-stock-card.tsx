"use client"

import { useEffect, useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { PackageX, Loader2, Pencil } from "lucide-react"
import { toast } from "sonner"
import { adminPackageService } from "@/lib/admin-service"
import { STOCK_TRACKED_NETWORKS, type NetworkStockMap } from "@/lib/network-stock-service"
import { STOCK_REASON_MAX, defaultStockReason } from "@/lib/network-stock-notice"

interface NetworkStockCardProps {
  // Called after a successful toggle so the parent can reload its package
  // list — is_available just changed underneath it, server-side.
  onChanged: () => void
}

// The dialog either confirms a new out-of-stock ("disable") or edits the
// reason of a network that is already out of stock ("edit").
type DialogState = { network: string; mode: "disable" | "edit" } | null

export function NetworkStockCard({ onChanged }: NetworkStockCardProps) {
  const [stock, setStock] = useState<NetworkStockMap>({})
  const [loading, setLoading] = useState(true)
  const [updatingNetwork, setUpdatingNetwork] = useState<string | null>(null)
  const [dialog, setDialog] = useState<DialogState>(null)
  const [reasonDraft, setReasonDraft] = useState("")

  const fetchStock = async () => {
    setLoading(true)
    try {
      const data = await adminPackageService.getNetworkStock()
      setStock(data || {})
    } catch (error: any) {
      toast.error(error?.message || "Failed to load network stock status")
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchStock()
  }, [])

  const applyToggle = async (network: string, outOfStock: boolean, reason?: string | null) => {
    setUpdatingNetwork(network)
    try {
      const result = await adminPackageService.setNetworkStock(network, outOfStock, reason)
      setStock((prev) => ({
        ...prev,
        [network]: outOfStock ? { ...prev[network], outOfStock: true } : { outOfStock: false },
      }))
      // Re-fetch to pick up the authoritative snapshot + reason the server
      // just wrote (or cleared) — local state above is a fast optimistic
      // placeholder for the badge/switch only.
      fetchStock()
      if (result.reasonUpdated) {
        toast.success(`${network} reason updated`)
      } else {
        toast.success(
          outOfStock
            ? `${network} marked out of stock — ${result.affected} package${result.affected === 1 ? "" : "s"} disabled`
            : `${network} restocked — ${result.affected} package${result.affected === 1 ? "" : "s"} re-enabled`
        )
        onChanged()
      }
    } catch (error: any) {
      toast.error(error?.message || `Failed to update ${network} stock status`)
    } finally {
      setUpdatingNetwork(null)
    }
  }

  const openDialog = (network: string, mode: "disable" | "edit") => {
    setReasonDraft(mode === "edit" ? stock[network]?.reason ?? "" : "")
    setDialog({ network, mode })
  }

  const handleSwitchChange = (network: string, checked: boolean) => {
    // checked = "in stock" (switch ON). Turning OFF -> mark out of stock,
    // which is consequential (can make every bundle of the network
    // unsellable), so confirm first. Turning ON -> restock, which is the
    // safe/reversible direction, so apply immediately.
    if (!checked) {
      openDialog(network, "disable")
    } else {
      applyToggle(network, false)
    }
  }

  const confirmDialog = () => {
    if (!dialog) return
    const { network } = dialog
    // Blank = no reason: customers see the default message.
    const reason = reasonDraft.trim() === "" ? null : reasonDraft
    setDialog(null)
    applyToggle(network, true, reason)
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><PackageX className="w-4 h-4" /> Network Stock Status</CardTitle>
        <CardDescription>
          Mark an entire network out of stock to temporarily disable all of its packages. Customers still see the network and are shown your reason when they pick it. Restocking re-enables only the packages that were disabled by the last out-of-stock toggle.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="p-6 text-center text-sm text-muted-foreground">Loading...</div>
        ) : (
          <div className="divide-y rounded-lg border">
            {STOCK_TRACKED_NETWORKS.map((network) => {
              const outOfStock = stock[network]?.outOfStock === true
              const isUpdating = updatingNetwork === network
              const reason = stock[network]?.reason
              return (
                <div key={network} className="flex items-center justify-between gap-3 p-3">
                  <div className="min-w-0 space-y-1">
                    <div className="flex items-center gap-3">
                      <span className="text-sm font-medium">{network}</span>
                      <Badge
                        variant={outOfStock ? "outline" : "secondary"}
                        className={outOfStock ? "bg-destructive/15 text-destructive border-border" : "bg-success/15 text-success border-border"}
                      >
                        {outOfStock ? "Out of Stock" : "In Stock"}
                      </Badge>
                    </div>
                    {outOfStock && (
                      <p className="text-xs text-muted-foreground break-words">
                        Customers see: {reason ? `“${reason}”` : "Default message"}
                      </p>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {isUpdating && <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />}
                    {outOfStock && (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={isUpdating}
                        onClick={() => openDialog(network, "edit")}
                      >
                        <Pencil className="w-3.5 h-3.5" /> Edit reason
                      </Button>
                    )}
                    <Switch
                      checked={!outOfStock}
                      disabled={isUpdating}
                      aria-label={`Toggle ${network} in stock`}
                      onCheckedChange={(checked) => handleSwitchChange(network, checked)}
                    />
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </CardContent>

      <AlertDialog open={dialog !== null} onOpenChange={(open) => !open && setDialog(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {dialog?.mode === "edit" ? `Update ${dialog.network} reason` : `Mark ${dialog?.network} out of stock?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {dialog?.mode === "edit"
                ? `Change what customers see when they pick ${dialog.network}. Packages stay disabled.`
                : `All currently available ${dialog?.network} packages will be disabled until you restock this network. Customers will not be able to purchase ${dialog?.network} bundles on any surface (dashboard, shop, USSD, WhatsApp) while it's out of stock.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-2">
            <Label htmlFor="network-stock-reason">Reason customers will see (optional)</Label>
            <Textarea
              id="network-stock-reason"
              value={reasonDraft}
              maxLength={STOCK_REASON_MAX}
              rows={3}
              placeholder={dialog ? defaultStockReason(dialog.network) : ""}
              onChange={(e) => setReasonDraft(e.target.value)}
            />
            <p className="text-right text-xs text-muted-foreground">{reasonDraft.length}/{STOCK_REASON_MAX}</p>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDialog}
              className={dialog?.mode === "edit" ? undefined : "bg-destructive hover:bg-destructive/90"}
            >
              {dialog?.mode === "edit" ? "Save reason" : "Mark Out of Stock"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  )
}
