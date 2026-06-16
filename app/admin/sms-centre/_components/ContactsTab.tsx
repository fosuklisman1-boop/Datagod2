"use client"

import { useCallback, useEffect, useState } from "react"
import { api } from "../_lib/api"

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

export default function ContactsTab() {
  const [groups, setGroups] = useState<Group[]>([])
  const [selected, setSelected] = useState<Group | null>(null)
  const [contacts, setContacts] = useState<Contact[]>([])
  const [msg, setMsg] = useState("")
  const [busy, setBusy] = useState(false)

  // create-group form
  const [gName, setGName] = useState("")
  const [gDesc, setGDesc] = useState("")

  // add-contact form
  const [cFirst, setCFirst] = useState("")
  const [cLast, setCLast] = useState("")
  const [cPhone, setCPhone] = useState("")

  // bulk import
  const [bulk, setBulk] = useState("")

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
    setMsg("")
    const res = await api<Group>("/api/admin/sms-groups", {
      method: "POST",
      body: JSON.stringify({ name: gName, description: gDesc || null }),
    })
    setBusy(false)
    if (res.success) {
      setGName("")
      setGDesc("")
      await loadGroups()
    } else setMsg(`Error: ${res.error}`)
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
      await loadGroups()
    } else setMsg(`Error: ${res.error}`)
  }

  async function addContact() {
    if (!selected || !cPhone.trim()) return
    setBusy(true)
    setMsg("")
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
      await Promise.all([loadGroup(selected.id), loadGroups()])
    } else setMsg(`Error: ${res.error}`)
  }

  async function importBulk() {
    if (!selected || !bulk.trim()) return
    // Each line: phone[,firstName[,lastName]]
    const rows = bulk
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const [phone_number, first_name, last_name] = l.split(",").map((p) => p.trim())
        return { phone_number, first_name: first_name || null, last_name: last_name || null }
      })
      .filter((r) => r.phone_number)

    if (rows.length === 0) return
    setBusy(true)
    setMsg("")
    const res = await api<{ inserted: number; skipped: number }>("/api/admin/sms-contacts", {
      method: "POST",
      body: JSON.stringify({ group_id: selected.id, rows }),
    })
    setBusy(false)
    if (res.success && res.data) {
      setBulk("")
      setMsg(`Imported ${res.data.inserted}; skipped ${res.data.skipped} (invalid/duplicate).`)
      await Promise.all([loadGroup(selected.id), loadGroups()])
    } else setMsg(`Error: ${res.error}`)
  }

  async function toggleOptOut(c: Contact) {
    setBusy(true)
    const res = await api(`/api/admin/sms-contacts/${c.id}`, {
      method: "PATCH",
      body: JSON.stringify({ opted_out: !c.opted_out }),
    })
    setBusy(false)
    if (res.success && selected) await loadGroup(selected.id)
    else if (!res.success) setMsg(`Error: ${res.error}`)
  }

  async function deleteContact(c: Contact) {
    setBusy(true)
    const res = await api(`/api/admin/sms-contacts/${c.id}`, { method: "DELETE" })
    setBusy(false)
    if (res.success && selected) await Promise.all([loadGroup(selected.id), loadGroups()])
    else if (!res.success) setMsg(`Error: ${res.error}`)
  }

  return (
    <div className="space-y-4">
      {msg && <p className="text-sm rounded border bg-muted/40 px-3 py-2">{msg}</p>}

      <div className="grid gap-4 md:grid-cols-[18rem_1fr]">
        {/* Groups column */}
        <section className="rounded-lg border p-4 space-y-3">
          <h2 className="font-semibold">Groups</h2>

          <div className="space-y-2">
            <input
              value={gName}
              onChange={(e) => setGName(e.target.value)}
              placeholder="New group name"
              maxLength={100}
              className="w-full rounded border px-2 py-1 text-sm"
            />
            <input
              value={gDesc}
              onChange={(e) => setGDesc(e.target.value)}
              placeholder="Description (optional)"
              className="w-full rounded border px-2 py-1 text-sm"
            />
            <button
              onClick={createGroup}
              disabled={busy || !gName.trim()}
              className="w-full rounded bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50"
            >
              Create group
            </button>
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
                <button
                  onClick={() => deleteGroup(g)}
                  className="shrink-0 rounded border border-red-200 px-2 py-0.5 text-xs text-red-600 hover:bg-red-50"
                >
                  Delete
                </button>
              </li>
            ))}
            {groups.length === 0 && <li className="py-2 text-sm text-muted-foreground">No groups yet.</li>}
          </ul>
        </section>

        {/* Contacts column */}
        <section className="rounded-lg border p-4 space-y-4">
          {!selected ? (
            <p className="text-sm text-muted-foreground">Select a group to manage its contacts.</p>
          ) : (
            <>
              <h2 className="font-semibold">{selected.name} — contacts</h2>

              {/* Add single */}
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <input
                  value={cFirst}
                  onChange={(e) => setCFirst(e.target.value)}
                  placeholder="First name"
                  className="rounded border px-2 py-1 text-sm"
                />
                <input
                  value={cLast}
                  onChange={(e) => setCLast(e.target.value)}
                  placeholder="Last name"
                  className="rounded border px-2 py-1 text-sm"
                />
                <input
                  value={cPhone}
                  onChange={(e) => setCPhone(e.target.value)}
                  placeholder="Phone (0XXXXXXXXX)"
                  className="rounded border px-2 py-1 text-sm"
                />
                <button
                  onClick={addContact}
                  disabled={busy || !cPhone.trim()}
                  className="rounded bg-primary px-3 py-1 text-sm text-primary-foreground disabled:opacity-50"
                >
                  Add
                </button>
              </div>

              {/* Bulk import */}
              <details className="rounded border p-2">
                <summary className="cursor-pointer text-sm font-medium">Bulk import</summary>
                <p className="mt-2 text-xs text-muted-foreground">
                  One per line: <code>phone,firstName,lastName</code> (name fields optional). Invalid numbers
                  and duplicates are skipped automatically.
                </p>
                <textarea
                  value={bulk}
                  onChange={(e) => setBulk(e.target.value)}
                  rows={5}
                  placeholder={"0241234567,Ama,Mensah\n0207654321"}
                  className="mt-2 w-full rounded border px-2 py-1 text-sm font-mono"
                />
                <button
                  onClick={importBulk}
                  disabled={busy || !bulk.trim()}
                  className="mt-2 rounded bg-primary px-3 py-1 text-sm text-primary-foreground disabled:opacity-50"
                >
                  Import
                </button>
              </details>

              {/* Contacts table */}
              {contacts.length === 0 ? (
                <p className="text-sm text-muted-foreground">No contacts in this group.</p>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-muted-foreground">
                      <th className="py-1.5 font-medium">Name</th>
                      <th className="py-1.5 font-medium">Phone</th>
                      <th className="py-1.5 font-medium">Status</th>
                      <th className="py-1.5 font-medium text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {contacts.map((c) => (
                      <tr key={c.id} className="border-b last:border-0">
                        <td className="py-1.5">{[c.first_name, c.last_name].filter(Boolean).join(" ") || "—"}</td>
                        <td className="py-1.5 font-mono">{c.phone_number}</td>
                        <td className="py-1.5">
                          {c.opted_out ? (
                            <span className="rounded bg-red-100 px-2 py-0.5 text-xs text-red-700">opted out</span>
                          ) : (
                            <span className="rounded bg-green-100 px-2 py-0.5 text-xs text-green-700">active</span>
                          )}
                        </td>
                        <td className="py-1.5 text-right">
                          <button onClick={() => toggleOptOut(c)} className="mr-2 text-xs underline">
                            {c.opted_out ? "Re-include" : "Opt out"}
                          </button>
                          <button onClick={() => deleteContact(c)} className="text-xs text-red-600 underline">
                            Delete
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  )
}
