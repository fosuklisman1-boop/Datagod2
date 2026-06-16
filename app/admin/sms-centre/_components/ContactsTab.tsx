"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { api } from "../_lib/api"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { toast } from "sonner"
import { Loader2, Plus, Trash2, Upload, UserPlus } from "lucide-react"

interface Group {
  id: string
  name: string
  description: string | null
  contact_count?: number
}

interface Contact {
  id: string
  group_id: string
  first_name: string | null
  last_name: string | null
  phone_number: string
  opted_out: boolean
}

type BulkRow = { phone_number: string; first_name: string | null; last_name: string | null }

interface BulkResult {
  inserted: number
  skipped: number
  skippedSamples?: string[]
}

// Parse CSV/paste text into rows. Each line: phone[,firstName[,lastName]].
// Tolerates a header row (skipped if the first cell is non-numeric).
function parseRows(text: string): BulkRow[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  const rows: BulkRow[] = []
  lines.forEach((line, i) => {
    const [phone_number, first_name, last_name] = line.split(",").map((p) => p.trim())
    if (!phone_number) return
    // Skip a header row: first line whose phone cell has no digits.
    if (i === 0 && !/\d/.test(phone_number)) return
    rows.push({ phone_number, first_name: first_name || null, last_name: last_name || null })
  })
  return rows
}

export default function ContactsTab() {
  const [groups, setGroups] = useState<Group[]>([])
  const [selected, setSelected] = useState<Group | null>(null)
  const [contacts, setContacts] = useState<Contact[]>([])
  const [busy, setBusy] = useState(false)

  // create-group form
  const [gName, setGName] = useState("")
  const [gDesc, setGDesc] = useState("")

  // add-contact form
  const [cFirst, setCFirst] = useState("")
  const [cLast, setCLast] = useState("")
  const [cPhone, setCPhone] = useState("")

  // bulk import (paste)
  const [bulk, setBulk] = useState("")
  const fileRef = useRef<HTMLInputElement>(null)

  const loadGroups = useCallback(async () => {
    const res = await api<Group[]>("/api/admin/sms-groups")
    if (res.success && res.data) setGroups(res.data)
  }, [])

  const loadGroup = useCallback(async (id: string) => {
    const res = await api<{ group: Group; contacts: Contact[] }>(`/api/admin/sms-groups/${id}`)
    if (res.success && res.data) {
      setSelected(res.data.group)
      setContacts(res.data.contacts)
    }
  }, [])

  useEffect(() => {
    loadGroups()
  }, [loadGroups])

  async function createGroup() {
    if (!gName.trim()) return
    setBusy(true)
    const res = await api<Group>("/api/admin/sms-groups", {
      method: "POST",
      body: JSON.stringify({ name: gName, description: gDesc || null }),
    })
    setBusy(false)
    if (res.success) {
      setGName("")
      setGDesc("")
      toast.success("Group created.")
      await loadGroups()
    } else toast.error(res.error ?? "Failed to create group")
  }

  async function deleteGroup(g: Group) {
    if (!confirm(`Delete group "${g.name}" and all its contacts?`)) return
    setBusy(true)
    const res = await api(`/api/admin/sms-groups/${g.id}`, { method: "DELETE" })
    setBusy(false)
    if (res.success) {
      if (selected?.id === g.id) {
        setSelected(null)
        setContacts([])
      }
      toast.success("Group deleted.")
      await loadGroups()
    } else toast.error(res.error ?? "Failed to delete group")
  }

  async function addContact() {
    if (!selected || !cPhone.trim()) return
    setBusy(true)
    const res = await api("/api/admin/sms-contacts", {
      method: "POST",
      body: JSON.stringify({
        group_id: selected.id,
        phone_number: cPhone,
        first_name: cFirst || null,
        last_name: cLast || null,
      }),
    })
    setBusy(false)
    if (res.success) {
      setCFirst("")
      setCLast("")
      setCPhone("")
      toast.success("Contact added.")
      await Promise.all([loadGroup(selected.id), loadGroups()])
    } else toast.error(res.error ?? "Failed to add contact")
  }

  async function postRows(rows: BulkRow[]) {
    if (!selected || rows.length === 0) {
      toast.error("No valid rows found (expected: phone,firstName,lastName)")
      return
    }
    setBusy(true)
    const res = await api<BulkResult>("/api/admin/sms-contacts", {
      method: "POST",
      body: JSON.stringify({ group_id: selected.id, rows }),
    })
    setBusy(false)
    if (res.success && res.data) {
      toast.success(`Imported ${res.data.inserted}; skipped ${res.data.skipped} (invalid/duplicate).`)
      await Promise.all([loadGroup(selected.id), loadGroups()])
    } else toast.error(res.error ?? "Import failed")
  }

  async function importBulk() {
    const rows = parseRows(bulk)
    if (rows.length === 0) return toast.error("No valid rows to import.")
    await postRows(rows)
    setBulk("")
  }

  async function importCsvFile(file: File) {
    if (!selected) return
    try {
      const text = await file.text()
      const rows = parseRows(text)
      if (rows.length === 0) return toast.error("CSV had no valid rows.")
      await postRows(rows)
    } catch {
      toast.error("Could not read that file.")
    } finally {
      if (fileRef.current) fileRef.current.value = ""
    }
  }

  async function toggleOptOut(c: Contact) {
    setBusy(true)
    const res = await api(`/api/admin/sms-contacts/${c.id}`, {
      method: "PATCH",
      body: JSON.stringify({ opted_out: !c.opted_out }),
    })
    setBusy(false)
    if (res.success && selected) await loadGroup(selected.id)
    else if (!res.success) toast.error(res.error ?? "Failed to update contact")
  }

  async function deleteContact(c: Contact) {
    setBusy(true)
    const res = await api(`/api/admin/sms-contacts/${c.id}`, { method: "DELETE" })
    setBusy(false)
    if (res.success && selected) await Promise.all([loadGroup(selected.id), loadGroups()])
    else if (!res.success) toast.error(res.error ?? "Failed to delete contact")
  }

  return (
    <div className="grid gap-4 md:grid-cols-[19rem_1fr]">
      {/* Groups column */}
      <Card className="self-start">
        <CardHeader>
          <CardTitle className="text-base">Groups</CardTitle>
          <CardDescription>Address-book groups for targeted SMS.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Input value={gName} onChange={(e) => setGName(e.target.value)} placeholder="New group name" maxLength={100} />
            <Input
              value={gDesc}
              onChange={(e) => setGDesc(e.target.value)}
              placeholder="Description (optional)"
            />
            <Button className="w-full" onClick={createGroup} disabled={busy || !gName.trim()}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Create group
            </Button>
          </div>

          <ul className="divide-y">
            {groups.map((g) => (
              <li key={g.id} className="flex items-center justify-between gap-2 py-2">
                <button
                  onClick={() => loadGroup(g.id)}
                  className={`min-w-0 flex-1 text-left text-sm ${
                    selected?.id === g.id ? "font-semibold text-primary" : ""
                  }`}
                >
                  <span className="block truncate">{g.name}</span>
                  <span className="text-xs text-muted-foreground">{g.contact_count ?? 0} contacts</span>
                </button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 shrink-0 text-destructive hover:text-destructive"
                  onClick={() => deleteGroup(g)}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </li>
            ))}
            {groups.length === 0 && <li className="py-2 text-sm text-muted-foreground">No groups yet.</li>}
          </ul>
        </CardContent>
      </Card>

      {/* Contacts column */}
      <div className="space-y-4">
        {!selected ? (
          <Card>
            <CardContent className="py-10 text-center text-sm text-muted-foreground">
              Select a group to manage its contacts.
            </CardContent>
          </Card>
        ) : (
          <>
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <UserPlus className="h-4 w-4" /> Add to {selected.name}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {/* Add single */}
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <Input value={cFirst} onChange={(e) => setCFirst(e.target.value)} placeholder="First name" />
                  <Input value={cLast} onChange={(e) => setCLast(e.target.value)} placeholder="Last name" />
                  <Input value={cPhone} onChange={(e) => setCPhone(e.target.value)} placeholder="Phone (0XXXXXXXXX)" />
                  <Button onClick={addContact} disabled={busy || !cPhone.trim()}>
                    {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Add
                  </Button>
                </div>

                {/* CSV upload */}
                <div className="space-y-2 rounded-lg border p-3">
                  <Label className="flex items-center gap-2 text-sm font-medium">
                    <Upload className="h-4 w-4" /> Upload CSV
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    Columns: <code>phone,firstName,lastName</code> (name fields optional; a header row is tolerated).
                  </p>
                  <Input
                    ref={fileRef}
                    type="file"
                    accept=".csv,text/csv"
                    disabled={busy}
                    onChange={(e) => {
                      const f = e.target.files?.[0]
                      if (f) importCsvFile(f)
                    }}
                  />
                </div>

                {/* Bulk paste */}
                <div className="space-y-2">
                  <Label htmlFor="bulk" className="text-sm font-medium">
                    …or paste rows
                  </Label>
                  <Textarea
                    id="bulk"
                    value={bulk}
                    onChange={(e) => setBulk(e.target.value)}
                    rows={4}
                    placeholder={"0241234567,Ama,Mensah\n0207654321"}
                    className="font-mono text-sm"
                  />
                  <Button variant="outline" onClick={importBulk} disabled={busy || !bulk.trim()}>
                    {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />} Import pasted rows
                  </Button>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Contacts ({contacts.length})</CardTitle>
              </CardHeader>
              <CardContent>
                {contacts.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No contacts in this group.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b text-left text-muted-foreground">
                          <th className="py-2 font-medium">Name</th>
                          <th className="py-2 font-medium">Phone</th>
                          <th className="py-2 font-medium">Status</th>
                          <th className="py-2 text-right font-medium">Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {contacts.map((c) => (
                          <tr key={c.id} className="border-b last:border-0">
                            <td className="py-2">{[c.first_name, c.last_name].filter(Boolean).join(" ") || "—"}</td>
                            <td className="py-2 font-mono">{c.phone_number}</td>
                            <td className="py-2">
                              {c.opted_out ? (
                                <Badge variant="destructive">opted out</Badge>
                              ) : (
                                <Badge className="bg-green-100 text-green-700">active</Badge>
                              )}
                            </td>
                            <td className="py-2 text-right">
                              <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => toggleOptOut(c)}>
                                {c.opted_out ? "Re-include" : "Opt out"}
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 text-xs text-destructive hover:text-destructive"
                                onClick={() => deleteContact(c)}
                              >
                                Delete
                              </Button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </div>
  )
}
