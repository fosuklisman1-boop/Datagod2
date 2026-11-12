"use client"

import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { AlertCircle, Loader2, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { adminUserService } from "@/lib/admin-service"
import type { AccountTarget } from "./types"

interface AccountActionsDialogProps {
  user: AccountTarget | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onChanged: () => void
  /** Called with the id of a user that was permanently deleted. */
  onDeleted?: (userId: string) => void
}

/** Suspend / unsuspend, or permanently delete, a user. */
export function AccountActionsDialog({ user, open, onOpenChange, onChanged, onDeleted }: AccountActionsDialogProps) {
  const selectedUser = user
  const [isProcessingAction, setIsProcessingAction] = useState(false)
  const [suspensionReason, setSuspensionReason] = useState("")

  useEffect(() => {
    if (open) setSuspensionReason("")
  }, [open, user?.id])

  const handleRemoveUser = async (userId: string) => {
    if (!confirm("Are you sure you want to PERMANENTLY delete this user? This cannot be undone.")) return

    setIsProcessingAction(true)
    try {
      await adminUserService.removeUser(userId)
      toast.success("User removed successfully")
      onDeleted?.(userId)
      onOpenChange(false)
      onChanged()
    } catch (error: any) {
      console.error("Error removing user:", error)
      toast.error(error.message || "Failed to remove user")
    } finally {
      setIsProcessingAction(false)
    }
  }

  const handleToggleSuspension = async (userId: string, currentStatus: boolean | undefined) => {
    setIsProcessingAction(true)
    const action = currentStatus ? "unsuspend" : "suspend"
    try {
      const result = await adminUserService.toggleUserSuspension(userId, action, suspensionReason)

      const smsStatus = result.notifications?.sms
        ? "✓ SMS sent"
        : `✗ SMS ${result.diagnostics?.SMS_ENABLED ? "failed" : "disabled"}`
      const emailStatus = result.notifications?.email ? "✓ Email sent" : "✗ Email skipped"

      toast.success(`User ${action}ed. Notifications: ${smsStatus}, ${emailStatus}`, {
        duration: 5000
      })

      if (result.notifications?.sms_error) {
        console.warn("SMS Error:", result.notifications.sms_error)
      }

      onOpenChange(false)
      setSuspensionReason("")
      onChanged()
    } catch (error: any) {
      console.error(`Error ${action}ing user:`, error)
      toast.error(error.message || `Failed to ${action} user`)
    } finally {
      setIsProcessingAction(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-destructive">
            <AlertCircle className="w-5 h-5" />
            DANGER ZONE: Account Actions
          </DialogTitle>
          <DialogDescription>
            Select an action for user: {selectedUser?.email}
          </DialogDescription>
        </DialogHeader>
        {selectedUser && (
          <div className="space-y-6 pt-2">
        
            {/* Suspend Action */}
            <div className="p-4 border rounded-lg bg-warning/10 border-border">
              <h3 className="font-semibold text-warning text-sm">
                {selectedUser.is_suspended ? "Unsuspend Account" : "Suspend Account (Temporary)"}
              </h3>
              <p className="text-xs text-warning mt-1 mb-3">
                {selectedUser.is_suspended 
                  ? "Restores the user's ability to log in."
                  : "Bans the user from logging in without destroying their data or shop."}
              </p>
          
              {!selectedUser.is_suspended && (
                <div className="mb-4">
                  <Label className="text-xs text-warning mb-1 block">Reason for Suspension (Optional)</Label>
                  <textarea
                    className="w-full text-sm p-2 border rounded bg-background border-white/60 dark:border-white/5 clay-inset"
                    placeholder="e.g. Violation of terms, suspicious activity..."
                    rows={2}
                    value={suspensionReason}
                    onChange={(e) => setSuspensionReason(e.target.value)}
                  />
                </div>
              )}

              <Button
                onClick={() => handleToggleSuspension(selectedUser.id, selectedUser.is_suspended)}
                disabled={isProcessingAction}
                variant="outline"
                className="w-full bg-card text-warning border-border hover:bg-warning/15"
              >
                {isProcessingAction ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
                {selectedUser.is_suspended ? "Unsuspend User" : "Suspend User"}
              </Button>
            </div>

            {/* Hard Delete Action */}
            <div className="p-4 border rounded-lg bg-destructive/10 border-border">
              <h3 className="font-semibold text-destructive text-sm">Permanently Delete Account</h3>
              <p className="text-xs text-destructive mt-1 mb-3">
                Destroys all user data, wallet, shop records, and transactions forever. <strong>This cannot be undone.</strong>
              </p>
              <Button
                onClick={() => handleRemoveUser(selectedUser.id)}
                disabled={isProcessingAction}
                variant="destructive"
                className="w-full"
              >
                {isProcessingAction ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Trash2 className="w-4 h-4 mr-2" />}
                Permanently Delete
              </Button>
            </div>

          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
