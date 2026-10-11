"use client"

import { Card, CardContent } from "@/components/ui/card"
import { SmsShell } from "../_components/SmsShell"
import { AddContacts } from "../_components/contacts/AddContacts"
import { ContactsTable } from "../_components/contacts/ContactsTable"
import { DeleteDialogs } from "../_components/contacts/DeleteDialogs"
import { GroupsList } from "../_components/contacts/GroupsList"
import { useContacts } from "../_components/contacts/useContacts"

function ContactsContent() {
  const c = useContacts()
  return (
    <>
      <div className="grid gap-4 lg:grid-cols-[19rem_1fr]">
        <GroupsList
          groups={c.groups} loaded={c.groupsLoaded} selectedId={c.selectedGroup?.id ?? null} busy={c.contactsBusy}
          onSelect={c.selectGroup} onCreate={c.createGroup} onDelete={c.setPendingDeleteGroup}
        />
        <div className="min-w-0 space-y-4">
          {!c.selectedGroup ? (
            <Card>
              <CardContent className="py-10 text-center text-sm text-muted-foreground">
                Select a group to manage its contacts.
              </CardContent>
            </Card>
          ) : (
            <>
              <AddContacts
                groupName={c.selectedGroup.name} busy={c.contactsBusy}
                onAddSingle={c.addContactSingle} onImportRows={c.postRows}
              />
              <ContactsTable
                contacts={c.contacts} busy={c.contactsBusy} verifying={c.verifying} verifyCounts={c.verifyCounts}
                onVerify={() => void c.reverifyGroup()} onToggleOptOut={(x) => void c.toggleOptOut(x)}
                onDelete={c.setPendingDeleteContact}
              />
            </>
          )}
        </div>
      </div>
      <DeleteDialogs
        busy={c.contactsBusy} group={c.pendingDeleteGroup} contact={c.pendingDeleteContact}
        onClearGroup={() => c.setPendingDeleteGroup(null)} onClearContact={() => c.setPendingDeleteContact(null)}
        onDeleteGroup={(g) => void c.deleteGroup(g)} onDeleteContact={(x) => void c.deleteContact(x)}
      />
    </>
  )
}

export default function SmsContactsPage() {
  return (
    <SmsShell backToHome subtitle="Contacts">
      <ContactsContent />
    </SmsShell>
  )
}
