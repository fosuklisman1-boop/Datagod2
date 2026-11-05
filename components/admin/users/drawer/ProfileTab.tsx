"use client"

import { useEffect, useState, type ReactNode } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { CheckCircle, KeyRound, Loader2, LogOut, Mail, Phone } from "lucide-react"
import { toast } from "sonner"
import { adminUserService } from "@/lib/admin-service"
import { ConfirmDialog, DuplicateWalletWarning, dateTime, ghs } from "./shared"
import type { DrawerProfile } from "./types"
import { ProfileSignals, TagsEditor } from "./ProfileSignals"

export interface ProfileActions {
  onAdjustWallet: () => void
  onChangePassword: () => void
  onAccountActions: () => void
  onCustomPrices: () => void
}

type Confirm = "logout" | "reset" | "phone" | null

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-xs text-muted-foreground">{label}</p>
      <div className="text-sm font-medium break-words">{children}</div>
    </div>
  )
}

/** Profile details, the existing edit actions, and the audited account actions. */
export function ProfileTab({ profile, onChanged, actions, refreshKey = 0 }: {
  profile: DrawerProfile
  /** Bumped when the drawer reloads; the activity signals refetch with it. */
  refreshKey?: number
  /** Something about the user changed: reload the drawer and the list. */
  onChanged: () => void
  actions: ProfileActions
}) {
  const [editEmail, setEditEmail] = useState(profile.email)
  const [editPhone, setEditPhone] = useState(profile.phoneNumber)
  const [newRole, setNewRole] = useState(profile.role)
  const [saving, setSaving] = useState(false)
  const [confirm, setConfirm] = useState<Confirm>(null)

  useEffect(() => {
    setEditEmail(profile.email)
    setEditPhone(profile.phoneNumber)
    setNewRole(profile.role)
  }, [profile])

  const saveDetails = async () => {
    if (!editEmail.trim()) return void toast.error("Email is required")
    setSaving(true)
    try {
      await adminUserService.updateUserDetails(profile.id, { email: editEmail, phoneNumber: editPhone })
      toast.success("User details updated")
      onChanged()
    } catch (e: any) {
      toast.error(e?.message || "Failed to update user details")
    } finally {
      setSaving(false)
    }
  }

  const saveRole = async () => {
    try {
      await adminUserService.updateUserRole(profile.id, newRole)
      toast.success(`Role updated to ${newRole}. They need to sign out and back in for it to apply.`)
      onChanged()
    } catch (e: any) {
      toast.error(e?.message || "Failed to update role")
    }
  }

  // Each action reports its own outcome; a thrown error keeps the confirmation open.
  const run = async (fn: () => Promise<string>) => {
    try {
      toast.success(await fn())
      onChanged()
    } catch (e: any) {
      toast.error(e?.message || "Action failed")
      throw e
    }
  }
  const auditNote = (audited: boolean) => (audited ? "" : " (warning: the audit log entry could not be written)")

  return (
    <div className="space-y-5">
      <DuplicateWalletWarning rows={profile.walletRows} />
      <div className="grid grid-cols-2 gap-3">
        <Field label="Email">{profile.email || "—"}</Field>
        <Field label="Phone">
          <span className="inline-flex items-center gap-1 flex-wrap">
            {profile.phoneNumber || "—"}
            {profile.phoneNumber && (
              <Badge className={profile.phoneVerified ? "bg-success" : "bg-warning"}>{profile.phoneVerified ? "verified" : "unverified"}</Badge>
            )}
          </span>
        </Field>
        <Field label="Name">{[profile.firstName, profile.lastName].filter(Boolean).join(" ") || "—"}</Field>
        <Field label="Role"><Badge className={profile.role === "admin" ? "bg-destructive" : "bg-primary"}>{profile.role}</Badge></Field>
        <Field label="Pricing">{profile.pricingMode === "custom" ? "Custom prices" : "Role prices"}</Field>
        <Field label="Wallet">{ghs(profile.walletBalance)}</Field>
        <Field label="Status">
          {profile.isSuspended ? <Badge className="bg-destructive">suspended</Badge> : <Badge className="bg-success">active</Badge>}
        </Field>
        <Field label="Created">{dateTime(profile.createdAt)}</Field>
        <Field label="Last sign-in">{profile.lastSignInAt ? dateTime(profile.lastSignInAt) : "Never"}</Field>
        {!profile.phoneVerified && profile.phoneVerifyDeadline && (
          <Field label="Phone verify deadline">{dateTime(profile.phoneVerifyDeadline)}</Field>
        )}
        {profile.isSuspended && (
          <div className="col-span-2">
            <Field label="Suspension reason">
              {profile.suspension?.reason || <span className="text-muted-foreground font-normal">Not recorded</span>}
              {profile.suspension && <span className="block text-xs text-muted-foreground font-normal">since {dateTime(profile.suspension.at)}</span>}
            </Field>
          </div>
        )}
        {!profile.hasProfile && (
          <p className="col-span-2 text-xs text-warning">This sign-in has no profile row; some actions will not work.</p>
        )}
      </div>

      <section className="space-y-2 border-t pt-4">
        <h4 className="text-sm font-semibold">Activity and risk</h4>
        <ProfileSignals userId={profile.id} refreshKey={refreshKey} />
      </section>

      <section className="space-y-2 border-t pt-4">
        <h4 className="text-sm font-semibold">Tags</h4>
        <TagsEditor userId={profile.id} refreshKey={refreshKey} onChanged={onChanged} />
      </section>

      <section className="space-y-3 border-t pt-4">
        <h4 className="text-sm font-semibold">Edit</h4>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label htmlFor="drawer-email">Email</Label>
            <Input id="drawer-email" value={editEmail} onChange={(e) => setEditEmail(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="drawer-phone">Phone</Label>
            <Input id="drawer-phone" value={editPhone} onChange={(e) => setEditPhone(e.target.value)} placeholder="No phone number" />
          </div>
        </div>
        <Button size="sm" onClick={saveDetails} disabled={saving} className="gap-2">
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle className="w-4 h-4" />}
          Update email / phone
        </Button>
        <div className="flex items-end gap-2">
          <div className="flex-1 space-y-1">
            <Label htmlFor="drawer-role">Role</Label>
            <select id="drawer-role" value={newRole} onChange={(e) => setNewRole(e.target.value)}
              className="w-full px-3 py-2 border border-border rounded-md bg-background text-sm">
              <option value="user">User</option>
              <option value="dealer">Dealer</option>
              <option value="admin">Admin</option>
            </select>
          </div>
          <Button size="sm" variant="outline" onClick={saveRole} disabled={newRole === profile.role}>Update role</Button>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={actions.onAdjustWallet} disabled={profile.walletRows !== 1}>Adjust wallet</Button>
          <Button size="sm" variant="outline" onClick={actions.onChangePassword}>Change password</Button>
          <Button size="sm" variant="outline" onClick={actions.onCustomPrices}>Custom prices</Button>
        </div>
      </section>

      <section className="space-y-2 border-t pt-4">
        <h4 className="text-sm font-semibold">Account actions</h4>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" className="gap-2" onClick={() => setConfirm("logout")}>
            <LogOut className="w-4 h-4" /> Sign out everywhere
          </Button>
          <Button size="sm" variant="outline" className="gap-2" onClick={() => setConfirm("reset")} disabled={!profile.email}>
            <Mail className="w-4 h-4" /> Send password reset email
          </Button>
          <Button size="sm" variant="outline" className="gap-2" onClick={() => setConfirm("phone")}
            disabled={!profile.hasProfile || (!profile.phoneVerified && !profile.phoneNumber)}>
            <Phone className="w-4 h-4" /> Mark phone {profile.phoneVerified ? "unverified" : "verified"}
          </Button>
          <Button size="sm" variant="outline" className="gap-2 text-destructive" onClick={actions.onAccountActions}>
            <KeyRound className="w-4 h-4" /> {profile.isSuspended ? "Unsuspend" : "Suspend"} or delete…
          </Button>
        </div>
      </section>

      <ConfirmDialog
        open={confirm === "logout"}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="Sign this user out everywhere?"
        description={<>
          <p>Every signed-in session of <strong>{profile.email}</strong> is ended. This is <strong>not</strong> a lockout:</p>
          <ul className="list-disc pl-5 space-y-1">
            <li>they can sign straight back in with their password;</li>
            <li>their API keys and the WhatsApp bot keep working;</li>
            <li>a page they already have open can keep reading data for up to an hour.</li>
          </ul>
          <p>To lock them out, suspend the account and send a password reset.</p>
        </>}
        confirmLabel="Sign out everywhere"
        destructive
        onConfirm={() => run(async () => {
          const r = await adminUserService.forceLogout(profile.id)
          return `Signed out of ${r.sessionsRevoked} session(s)${auditNote(r.audited)}`
        })}
      />
      <ConfirmDialog
        open={confirm === "reset"}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="Send a password reset email?"
        description={<p>A reset link is emailed to <strong>{profile.email}</strong>. It expires in 5 minutes. Their current password keeps working until they use it.</p>}
        confirmLabel="Send email"
        onConfirm={() => run(async () => {
          const r = await adminUserService.sendPasswordReset(profile.id)
          return `Reset email sent to ${r.email}${auditNote(r.audited)}`
        })}
      />
      <ConfirmDialog
        open={confirm === "phone"}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={profile.phoneVerified ? "Mark phone unverified?" : "Mark phone verified?"}
        description={profile.phoneVerified
          ? <>
              <p><strong>{profile.phoneNumber}</strong> will need to be verified again. Orders, withdrawals and other gated actions are blocked until it is (after any grace period left).</p>
              <p>Refunds for USSD and storefront orders on this number will no longer be paid to this account.</p>
            </>
          : <>
              <p><strong>{profile.phoneNumber}</strong> is marked verified without an OTP. Only do this if you have confirmed the number belongs to this user.</p>
              <p>Refunds for USSD and storefront orders placed with this number will be paid into this user&apos;s wallet. It is refused if another account already has this number verified.</p>
            </>}
        confirmLabel={profile.phoneVerified ? "Mark unverified" : "Mark verified"}
        destructive={profile.phoneVerified}
        onConfirm={() => run(async () => {
          const r = await adminUserService.setPhoneVerified(profile.id, !profile.phoneVerified)
          return `Phone marked ${r.phoneVerified ? "verified" : "unverified"}${auditNote(r.audited)}`
        })}
      />
    </div>
  )
}
