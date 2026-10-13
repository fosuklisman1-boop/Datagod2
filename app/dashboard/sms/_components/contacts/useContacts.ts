"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { smsFetch, type SmsResult } from "../../_lib/api"
import type { BulkRow, Contact } from "../../_lib/view"
import type { BulkImportResult, Group, VerifyChunk, VerifyCounts } from "./types"

/** Server error text, or the monolith's fallback wording. */
function errMsg(r: SmsResult<unknown>, fallback: string): string {
  return typeof r.body.error === "string" ? r.body.error : fallback
}

const post = (path: string, body: unknown) => smsFetch(path, { method: "POST", body: JSON.stringify(body) })

/**
 * Address-book state + handlers (ported from the SMS monolith). Group loads are
 * guarded against out-of-order responses; the verify poll is bound to a group
 * via `verifyGroupRef` and stops on group switch, group delete or unmount.
 */
export function useContacts() {
  const [groups, setGroups] = useState<Group[]>([])
  const [groupsLoaded, setGroupsLoaded] = useState(false)
  const [selectedGroup, setSelectedGroup] = useState<Group | null>(null)
  const [contacts, setContacts] = useState<Contact[]>([])
  const [contactsBusy, setContactsBusy] = useState(false)
  const [verifyCounts, setVerifyCounts] = useState<VerifyCounts | null>(null)
  const [verifying, setVerifying] = useState(false)
  const [pendingDeleteGroup, setPendingDeleteGroup] = useState<Group | null>(null)
  const [pendingDeleteContact, setPendingDeleteContact] = useState<Contact | null>(null)

  const verifyGroupRef = useRef<string | null>(null)
  const verifyingRef = useRef(false)
  const selectedIdRef = useRef<string | null>(null)
  const loadSeq = useRef(0)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; verifyGroupRef.current = null; loadSeq.current++ }
  }, [])

  const loadGroups = useCallback(async () => {
    const r = await smsFetch<Group[]>("/api/sms/groups")
    if (!mounted.current) return
    if (r.ok) setGroups(r.data ?? [])
    setGroupsLoaded(true)
  }, [])

  useEffect(() => { void loadGroups() }, [loadGroups])

  // Loads a group's contacts + verify counts; ignores stale / out-of-order results.
  const loadGroup = useCallback(async (id: string) => {
    const seq = ++loadSeq.current
    const [grp, v] = await Promise.all([
      smsFetch<{ group: Group; contacts: Contact[] }>(`/api/sms/groups/${id}`),
      smsFetch<VerifyCounts>(`/api/sms/contacts/verify?groupId=${id}`),
    ])
    if (!mounted.current || seq !== loadSeq.current || selectedIdRef.current !== id) return
    if (grp.ok) { setSelectedGroup(grp.data.group); setContacts(grp.data.contacts ?? []) }
    if (v.ok) setVerifyCounts(v.data)
  }, [])

  function selectGroup(g: Group) {
    if (selectedIdRef.current === g.id) return
    selectedIdRef.current = g.id
    // Re-bind a running verify poll away from the old group so it stops cleanly.
    if (verifyGroupRef.current && verifyGroupRef.current !== g.id) verifyGroupRef.current = g.id
    setSelectedGroup(g); setContacts([]); setVerifyCounts(null)
    void loadGroup(g.id)
  }

  async function createGroup(name: string, description: string): Promise<boolean> {
    const n = name.trim()
    if (!n) return false
    setContactsBusy(true)
    const r = await post("/api/sms/groups", { name: n, description: description.trim() || undefined })
    setContactsBusy(false)
    if (r.ok) { toast.success("Group created."); await loadGroups(); return true }
    toast.error(errMsg(r, "Could not create group"))
    return false
  }

  async function deleteGroup(g: Group) {
    setContactsBusy(true)
    const r = await smsFetch(`/api/sms/groups/${g.id}`, { method: "DELETE" })
    setContactsBusy(false)
    if (r.ok) {
      if (selectedIdRef.current === g.id) {
        selectedIdRef.current = null
        verifyGroupRef.current = null
        loadSeq.current++
        setSelectedGroup(null); setContacts([]); setVerifyCounts(null)
      }
      toast.success("Group deleted."); await loadGroups()
    } else toast.error(errMsg(r, "Could not delete group"))
  }

  async function addContactSingle(first: string, last: string, phone: string): Promise<boolean> {
    if (!selectedGroup || !phone.trim()) return false
    const gid = selectedGroup.id
    setContactsBusy(true)
    const r = await post("/api/sms/contacts", {
      group_id: gid, phone_number: phone.trim(), first_name: first.trim() || undefined, last_name: last.trim() || undefined,
    })
    setContactsBusy(false)
    if (r.ok) { toast.success("Contact added."); await Promise.all([loadGroup(gid), loadGroups()]); return true }
    toast.error(errMsg(r, "Could not add contact"))
    return false
  }

  async function postRows(rows: BulkRow[], verifyOnImport: boolean) {
    if (!selectedGroup) return
    if (rows.length === 0) { toast.error("No valid rows found (expected: phone,firstName,lastName)."); return }
    const gid = selectedGroup.id
    setContactsBusy(true)
    const r = await post("/api/sms/contacts", { group_id: gid, rows, verify: verifyOnImport || undefined })
    setContactsBusy(false)
    if (r.ok) {
      const d = r.data as BulkImportResult
      toast.success(`Imported ${d.inserted}; skipped ${d.skipped} (invalid/duplicate).`)
      await Promise.all([loadGroup(gid), loadGroups()])
      if (verifyOnImport && d.pendingVerify > 0) void startVerifyPoll(gid)
    } else toast.error(errMsg(r, "Import failed"))
  }

  async function toggleOptOut(c: Contact) {
    if (!selectedGroup) return
    const gid = selectedGroup.id
    setContactsBusy(true)
    const r = await smsFetch(`/api/sms/contacts/${c.id}`, { method: "PATCH", body: JSON.stringify({ opted_out: !c.opted_out }) })
    setContactsBusy(false)
    if (r.ok) await loadGroup(gid)
    else toast.error(errMsg(r, "Could not update contact"))
  }

  async function deleteContact(c: Contact) {
    if (!selectedGroup) return
    const gid = selectedGroup.id
    setContactsBusy(true)
    const r = await smsFetch(`/api/sms/contacts/${c.id}`, { method: "DELETE" })
    setContactsBusy(false)
    if (r.ok) await Promise.all([loadGroup(gid), loadGroups()])
    else toast.error(errMsg(r, "Could not delete contact"))
  }

  // Sleep that wakes early when the poll is cancelled (group switch / unmount).
  async function sleepWhileBound(ms: number, groupId: string) {
    for (let waited = 0; waited < ms && verifyGroupRef.current === groupId; waited += 250) {
      await new Promise<void>((r) => setTimeout(r, 250))
    }
  }

  // Repeatedly POSTs one verify chunk until remaining=0, 30 iterations, or the
  // poll is cancelled. Backs off 8 s on a no-progress tick, else 1.5 s.
  async function startVerifyPoll(groupId: string) {
    if (verifyingRef.current) return // guard double-start
    verifyingRef.current = true
    setVerifying(true)
    verifyGroupRef.current = groupId
    toast.info("Verifying numbers…")
    let totalVerified = 0
    let totalInvalid = 0
    let completed = false
    try {
      for (let i = 0; i < 30; i++) {
        if (verifyGroupRef.current !== groupId) return
        const r = await post("/api/sms/contacts/verify", { groupId })
        if (verifyGroupRef.current !== groupId) return
        if (r.ok) {
          const chunk = r.data as VerifyChunk
          totalVerified += chunk.verified
          totalInvalid += chunk.invalid
          await loadGroup(groupId)
          if (chunk.remaining === 0) { completed = true; break }
          const noProgress = chunk.processed === 0 || (chunk.rateLimited > 0 && chunk.verified + chunk.invalid === 0)
          await sleepWhileBound(noProgress ? 8000 : 1500, groupId)
        } else {
          await sleepWhileBound(8000, groupId) // network blip — back off
        }
      }
      if (completed) toast.success(`Verification done: ${totalVerified} verified, ${totalInvalid} not found.`)
      else toast.info(`Verified ${totalVerified} so far; the rest will finish in the background.`)
    } finally {
      verifyingRef.current = false
      if (mounted.current) setVerifying(false)
      if (verifyGroupRef.current === groupId) verifyGroupRef.current = null
    }
  }

  // "Verify numbers": re-queue everything in the group, then poll.
  async function reverifyGroup() {
    if (!selectedGroup || verifyingRef.current) return
    const gid = selectedGroup.id
    const r = await post("/api/sms/contacts/verify", { groupId: gid, reverify: true })
    if (!r.ok) { toast.error(errMsg(r, "Could not start verification.")); return }
    if (!mounted.current) return
    if (selectedIdRef.current === gid) await loadGroup(gid)
    void startVerifyPoll(gid)
  }

  return {
    groups, groupsLoaded, selectedGroup, contacts, contactsBusy, verifyCounts, verifying,
    pendingDeleteGroup, setPendingDeleteGroup, pendingDeleteContact, setPendingDeleteContact,
    selectGroup, createGroup, deleteGroup, addContactSingle, postRows, toggleOptOut, deleteContact, reverifyGroup,
  }
}

export type ContactsApi = ReturnType<typeof useContacts>
