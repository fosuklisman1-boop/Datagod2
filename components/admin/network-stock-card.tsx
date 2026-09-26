"use client"

import { useEffect, useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { PackageX, Loader2 } from "lucide-react"
import { toast } from "sonner"
import { adminPackageService } from "@/lib/admin-service"
import { STOCK_TRACKED_NETWORKS, type NetworkStockMap } from "@/lib/network-stock-service"

interface NetworkStockCardProps {
  // Called after a successful toggle so the parent can reload its package
  // list — is_available just changed underneath it, server-side.
  onChanged: () => void
}

export function NetworkStockCard({ onChanged }: NetworkStockCardProps) {
  const [stock, setStock] = useState<NetworkStockMap>({})
  const [loading, setLoading] = useState(true)
  const [updatingNetwork, setUpdatingNetwork] = useState<string | null>(null)
  // Network currently pending the out-of-stock confirmation dialog
  const [confirmNetwork, setConfirmNetwork] = useState<string | null>(null)

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

  const applyToggle = async (network: string, outOfStock: boolean) => {
    setUpdatingNetwork(network)
    try {
      const result = await adminPackageService.setNetworkStock(network, outOfStock)
      setStock((prev) => ({
        ...prev,
        [network]: outOfStock ? { outOfStock: true } : { outOfStock: false },
      }))
      // Re-fetch to pick up the authoritative restoreIds snapshot the
      // server just wrote (or cleared) — local state above is a fast
      // optimistic placeholder for the badge/switch only.
      fetchStock()
      toast.success(
        outOfStock
          ? `${network} marked out of stock — ${result.affected} package${result.affected === 1 ? "" : "s"} disabled`
          : `${network} restocked — ${result.affected} package${result.affected === 1 ? "" : "s"} re-enabled`
      )
      onChanged()
    } catch (error: any) {
      toast.error(error?.message || `Failed to update ${network} stock status`)
    } finally {
      setUpdatingNetwork(null)
    }
  }

  const handleSwitchChange = (network: string, checked: boolean) => {
    // checked = "in stock" (switch ON). Turning OFF -> mark out of stock,
    // which is consequential (can make every bundle of the network
    // unsellable), so confirm first. Turning ON -> restock, which is the
    // safe/reversible direction, so apply immediately.
    if (!checked) {
      setConfirmNetwork(network)
    } else {
      applyToggle(network, false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><PackageX className="w-4 h-4" /> Network Stock Status</CardTitle>
        <CardDescription>
          Mark an entire network out of stock to temporarily disable all of its packages. Restocking re-enables only the packages that were disabled by the last out-of-stock toggle.
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
              return (
                <div key={network} className="flex items-center justify-between p-3">
                  <div className="flex items-center gap-3">
                    <span className="text-sm font-medium">{network}</span>
                    <Badge
                      variant={outOfStock ? "outline" : "secondary"}
                      className={outOfStock ? "bg-destructive/15 text-destructive border-border" : "bg-success/15 text-success border-border"}
                    >
                      {outOfStock ? "Out of Stock" : "In Stock"}
                    </Badge>
                  </div>
                  <div className="flex items-center gap-2">
                    {isUpdating && <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />}
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

      <AlertDialog open={confirmNetwork !== null} onOpenChange={(open) => !open && setConfirmNetwork(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Mark {confirmNetwork} out of stock?</AlertDialogTitle>
            <AlertDialogDescription>
              All currently available {confirmNetwork} packages will be disabled until you restock this network. Customers will not be able to purchase {confirmNetwork} bundles on any surface (dashboard, shop, USSD, WhatsApp) while it's out of stock.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const network = confirmNetwork!
                setConfirmNetwork(null)
                applyToggle(network, true)
              }}
              className="bg-destructive hover:bg-destructive/90"
            >
              Mark Out of Stock
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  )
}
