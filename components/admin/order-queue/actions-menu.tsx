"use client"

import { AlertCircle, ChevronDown, Download, Edit, FileSpreadsheet, Loader2, Zap } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

export type ActionsMenuProps = {
  selectedCount: number
  exporting: boolean
  onExportSelected: () => void
  /** Opens the (unchanged) date-range Bulk Status Update / download tool. */
  onOpenBulkTool: () => void
}

export function ActionsMenu({ selectedCount, exporting, onExportSelected, onOpenBulkTool }: ActionsMenuProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1">
          Actions
          <ChevronDown className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel className="text-xs text-muted-foreground">Selected orders</DropdownMenuLabel>
        <DropdownMenuItem disabled={selectedCount === 0 || exporting} onSelect={onExportSelected} className="cursor-pointer">
          {exporting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <FileSpreadsheet className="mr-2 h-4 w-4" />}
          Export selected{selectedCount > 0 ? ` (${selectedCount})` : ""}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-xs text-muted-foreground">By date range</DropdownMenuLabel>
        <DropdownMenuItem onSelect={onOpenBulkTool} className="cursor-pointer">
          <Edit className="mr-2 h-4 w-4" />
          Bulk status update &amp; downloads…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export type BulkToolDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  bulkDate: string
  setBulkDate: (v: string) => void
  bulkStartTime: string
  setBulkStartTime: (v: string) => void
  bulkEndTime: string
  setBulkEndTime: (v: string) => void
  bulkNetwork: string
  setBulkNetwork: (v: string) => void
  bulkStatus: string
  setBulkStatus: (v: string) => void
  bulkUpdating: boolean
  bulkDownloading: boolean
  bulkDownloadingFailed: boolean
  globalBulkCount: number | null
  onBulkStatusUpdate: () => void
  onBulkDownload: () => void
  onBulkDownloadFailed: () => void
}

const selectClass =
  "w-full px-3 py-2 border border-border rounded-md bg-background focus:outline-none focus:ring-2 focus:ring-ring"

/** The former "Bulk Status Update" card, moved into a dialog. Same fields, same handlers. */
export function BulkToolDialog(p: BulkToolDialogProps) {
  return (
    <Dialog open={p.open} onOpenChange={p.onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Edit className="h-5 w-5" />
            Bulk Status Update
          </DialogTitle>
          <DialogDescription>Update multiple orders at once by date, time, and network</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-sm font-medium">Date *</label>
              <Input type="date" value={p.bulkDate} onChange={(e) => p.setBulkDate(e.target.value)} required />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium">Network (Optional)</label>
              <select value={p.bulkNetwork} onChange={(e) => p.setBulkNetwork(e.target.value)} className={selectClass}>
                <option value="">All Networks</option>
                <option value="MTN">MTN</option>
                <option value="Telecel">Telecel</option>
                <option value="AT - iShare">AT - iShare</option>
                <option value="AT - BigTime">AT - BigTime</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium">Start Time (Optional)</label>
              <Input type="time" value={p.bulkStartTime} onChange={(e) => p.setBulkStartTime(e.target.value)} />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium">End Time (Optional)</label>
              <Input type="time" value={p.bulkEndTime} onChange={(e) => p.setBulkEndTime(e.target.value)} />
            </div>
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium">New Status *</label>
            <select value={p.bulkStatus} onChange={(e) => p.setBulkStatus(e.target.value)} className={selectClass} required>
              <option value="">Select status...</option>
              <option value="pending">Pending</option>
              <option value="processing">Processing</option>
              <option value="completed">Completed</option>
              <option value="failed">Failed</option>
            </select>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button
              onClick={p.onBulkStatusUpdate}
              disabled={p.bulkUpdating || !p.bulkDate || !p.bulkStatus}
              className="min-w-[140px] bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {p.bulkUpdating ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Updating...
                </>
              ) : (
                <>
                  <Zap className="mr-2 h-4 w-4" />
                  Update {p.globalBulkCount !== null ? `${p.globalBulkCount} ` : ""}Orders
                </>
              )}
            </Button>
            <Button
              variant="outline"
              onClick={p.onBulkDownload}
              disabled={p.bulkDownloading || !p.bulkDate}
              className="border-border font-semibold text-success hover:bg-success/10"
            >
              {p.bulkDownloading ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Preparing...
                </>
              ) : (
                <>
                  <Download className="mr-2 h-4 w-4" />
                  Download {p.globalBulkCount !== null ? `${p.globalBulkCount} ` : ""}Orders
                </>
              )}
            </Button>
            <Button
              variant="outline"
              onClick={p.onBulkDownloadFailed}
              disabled={p.bulkDownloadingFailed || !p.bulkDate}
              className="border-border font-semibold text-destructive hover:bg-destructive/10"
            >
              {p.bulkDownloadingFailed ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Preparing...
                </>
              ) : (
                <>
                  <Download className="mr-2 h-4 w-4" />
                  Download Failed Orders
                </>
              )}
            </Button>
          </div>

          {p.globalBulkCount !== null && (
            <p className="pt-1 text-xs font-medium text-primary">
              Found {p.globalBulkCount} pending/processing orders matching filters in the entire database.
            </p>
          )}

          <Alert>
            <AlertCircle className="h-4 w-4" />
            <AlertDescription className="text-xs">
              This will update/download ALL orders matching the criteria in the entire database. Date is required.
              Downloading claims the orders (marks them as downloaded) — use &quot;Export selected&quot; for a read-only sheet.
            </AlertDescription>
          </Alert>
        </div>
      </DialogContent>
    </Dialog>
  )
}
