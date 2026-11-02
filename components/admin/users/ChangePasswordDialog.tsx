"use client"

import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { toast } from "sonner"
import { adminUserService } from "@/lib/admin-service"
import { supabase } from "@/lib/supabase"
import type { AdminUser } from "./types"

interface ChangePasswordDialogProps {
  user: AdminUser | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

/** Set a new password for a user. The fields are cleared each time it opens. */
export function ChangePasswordDialog({ user, open, onOpenChange }: ChangePasswordDialogProps) {
  const selectedUser = user
  const [newPassword, setNewPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")
  const [isChangingPassword, setIsChangingPassword] = useState(false)

  useEffect(() => {
    if (open) {
      setNewPassword("")
      setConfirmPassword("")
    }
  }, [open])

  const handleChangePassword = async () => {
    if (!selectedUser || !newPassword) {
      toast.error("Please enter a new password")
      return
    }

    if (newPassword !== confirmPassword) {
      toast.error("Passwords do not match")
      return
    }

    if (newPassword.length < 6) {
      toast.error("Password must be at least 6 characters")
      return
    }

    setIsChangingPassword(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) {
        toast.error("Session expired. Please refresh the page.")
        setIsChangingPassword(false)
        return
      }

      await adminUserService.changeUserPassword(
        selectedUser.id,
        newPassword,
        session
      )

      toast.success("Password changed successfully")
      setNewPassword("")
      setConfirmPassword("")
      onOpenChange(false)
    } catch (error: any) {
      console.error("Error changing password:", error)
      toast.error(error.message || "Failed to change password")
    } finally {
      setIsChangingPassword(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Change User Password</DialogTitle>
          <DialogDescription>
            Set a new password for {selectedUser?.email}
          </DialogDescription>
        </DialogHeader>
        {selectedUser && (
          <div className="space-y-4">
            <div>
              <Label htmlFor="newPassword" className="text-xs">New Password</Label>
              <Input
                id="newPassword"
                type="password"
                placeholder="••••••••"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                disabled={isChangingPassword}
                className="mt-1"
              />
            </div>
            <div>
              <Label htmlFor="confirmPassword" className="text-xs">Confirm Password</Label>
              <Input
                id="confirmPassword"
                type="password"
                placeholder="••••••••"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                disabled={isChangingPassword}
                className="mt-1"
              />
            </div>
            <Button
              onClick={handleChangePassword}
              disabled={isChangingPassword}
              className="w-full bg-gradient-to-r from-primary to-primary hover:from-primary hover:to-primary"
            >
              {isChangingPassword ? "Changing..." : "Change Password"}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
