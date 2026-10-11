"use client"

import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { contactName, type Contact } from "../../_lib/view"
import type { Group } from "./types"

interface Props {
  busy: boolean
  group: Group | null
  contact: Contact | null
  onClearGroup: () => void
  onClearContact: () => void
  onDeleteGroup: (g: Group) => void
  onDeleteContact: (c: Contact) => void
}

export function DeleteDialogs({ busy, group, contact, onClearGroup, onClearContact, onDeleteGroup, onDeleteContact }: Props) {
  return (
    <>
      <AlertDialog open={group !== null} onOpenChange={(open) => !open && onClearGroup()}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete group?</AlertDialogTitle>
            <AlertDialogDescription>
              This deletes the group{group ? ` “${group.name}”` : ""} and all of its contacts. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() => { if (group) { const g = group; onClearGroup(); onDeleteGroup(g) } }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={contact !== null} onOpenChange={(open) => !open && onClearContact()}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete contact?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes {contact ? `“${contactName(contact)}” (${contact.phone_number})` : "this contact"} from the group. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() => { if (contact) { const c = contact; onClearContact(); onDeleteContact(c) } }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
