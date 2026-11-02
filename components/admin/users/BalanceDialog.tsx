"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"
import { adminUserService } from "@/lib/admin-service"
import type { AdminUser } from "./types"

interface BalanceDialogProps {
  user: AdminUser | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onChanged: () => void
}

/** Credit or debit a user's wallet. */
export function BalanceDialog({ user, open, onOpenChange, onChanged }: BalanceDialogProps) {
  const selectedUser = user
  const [balanceAction, setBalanceAction] = useState<"credit" | "debit">("credit")
  const [balanceAmount, setBalanceAmount] = useState("")
  const [isUpdatingBalance, setIsUpdatingBalance] = useState(false)

  const handleUpdateBalance = async () => {
    if (!selectedUser || !balanceAmount) {
      toast.error("Please enter an amount")
      return
    }

    try {
      setIsUpdatingBalance(true)

      await adminUserService.updateUserBalance(
        selectedUser.id,
        parseFloat(balanceAmount),
        balanceAction
      )

      toast.success(`Balance ${balanceAction === "credit" ? "credited" : "debited"} successfully`)
      setBalanceAmount("")
      onChanged()
      onOpenChange(false)
    } catch (error: any) {
      console.error("Error updating balance:", error)
      toast.error(error.message || "Failed to update balance")
    } finally {
      setIsUpdatingBalance(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Manage User Balance</DialogTitle>
        </DialogHeader>
        {selectedUser && (
          <div className="space-y-4">
            <div>
              <Label className="text-xs text-muted-foreground">User</Label>
              <p className="font-semibold mt-1">{selectedUser.email}</p>
            </div>
            <div>
              <Label className="text-xs text-muted-foreground">Current Balance</Label>
              <p className="font-semibold mt-1 text-success">GHS {selectedUser.balance.toFixed(2)}</p>
            </div>
            <div>
              <Label htmlFor="action" className="text-xs">Action</Label>
              <select
                id="action"
                aria-label="Select balance action"
                value={balanceAction}
                onChange={(e) => setBalanceAction(e.target.value as "credit" | "debit")}
                className="w-full mt-1 px-3 py-2 border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-ring"
              >
                <option value="credit">Credit (Add)</option>
                <option value="debit">Debit (Subtract)</option>
              </select>
            </div>
            <div>
              <Label htmlFor="amount" className="text-xs">Amount (GHS)</Label>
              <Input
                id="amount"
                type="number"
                placeholder="0.00"
                value={balanceAmount}
                onChange={(e) => setBalanceAmount(e.target.value)}
                className="mt-1"
                step="0.01"
              />
            </div>
            <Button
              onClick={handleUpdateBalance}
              disabled={isUpdatingBalance || !balanceAmount}
              className={`w-full ${balanceAction === "credit" ? "bg-success hover:bg-success/90" : "bg-destructive hover:bg-destructive/90"}`}
            >
              {isUpdatingBalance ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Processing...
                </>
              ) : (
                <>{balanceAction === "credit" ? "Credit" : "Debit"} Amount</>
              )}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
