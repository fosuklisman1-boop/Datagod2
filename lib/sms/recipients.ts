/**
 * Recipient resolver for admin broadcast.
 * Un-metered path — no credit RPCs, no content filter.
 */

import { normalizeGhanaPhone } from "@/lib/phone-format"
import type { SupabaseClient } from "@supabase/supabase-js"

export interface Contact {
  phone: string
  firstName?: string
  lastName?: string
}

export interface Skipped {
  rawPhone: string
  reason: "invalid_phone" | "opted_out" | "duplicate"
}

export interface ResolveResult {
  contacts: Contact[]
  skipped: Skipped[]
}

// ---------------------------------------------------------------------------
// buildContactList — pure transform; testable without DB
// ---------------------------------------------------------------------------

interface RawContactRow {
  phone_number: string
  first_name: string | null
  last_name: string | null
  opted_out: boolean
}

export function buildContactList(rows: RawContactRow[]): ResolveResult {
  const contacts: Contact[] = []
  const skipped: Skipped[] = []
  const seen = new Set<string>()

  for (const row of rows) {
    const normalised = normalizeGhanaPhone(row.phone_number)

    if (normalised === null) {
      skipped.push({ rawPhone: row.phone_number, reason: "invalid_phone" })
      continue
    }

    if (row.opted_out) {
      skipped.push({ rawPhone: row.phone_number, reason: "opted_out" })
      continue
    }

    if (seen.has(normalised)) {
      skipped.push({ rawPhone: row.phone_number, reason: "duplicate" })
      continue
    }

    seen.add(normalised)
    contacts.push({
      phone: normalised,
      firstName: row.first_name ?? undefined,
      lastName: row.last_name ?? undefined,
    })
  }

  return { contacts, skipped }
}

// ---------------------------------------------------------------------------
// AudienceSpec — the two supported audience shapes for admin broadcast
// ---------------------------------------------------------------------------

export type AudienceSpec =
  | { type: "users"; roles?: string[]; userIds?: string[] }
  | { type: "group"; groupId: string }

// ---------------------------------------------------------------------------
// resolveRecipients — fetches rows from DB then runs buildContactList
// ---------------------------------------------------------------------------

export async function resolveRecipients(
  spec: AudienceSpec,
  supabase: SupabaseClient
): Promise<ResolveResult> {
  if (spec.type === "group") {
    // Admin broadcast may target ONLY admin-global groups (sms_account_id IS NULL).
    // The inner join + NULL filter means a tenant-owned group id resolves to zero
    // recipients (the route's empty-group guard then rejects it), so an admin can
    // never broadcast to a tenant's private contact list.
    //
    // PAGINATE: PostgREST caps every response at max-rows (default 1000) regardless
    // of any .limit(), so a single fetch silently drops a group's contacts past
    // 1000. Page through with .range() (stable .order on id) so the FULL group is
    // resolved — a 3001-contact group must enqueue 3001, not 1000.
    const pageSize = 1000
    const rows: RawContactRow[] = []
    for (let from = 0; ; from += pageSize) {
      const { data, error } = await supabase
        .from("sms_contacts")
        .select("phone_number, first_name, last_name, opted_out, sms_groups!inner(sms_account_id)")
        .eq("group_id", spec.groupId)
        .is("sms_groups.sms_account_id", null)
        .order("id", { ascending: true })
        .range(from, from + pageSize - 1)
      if (error) throw error
      const batch = (data ?? []) as Array<Record<string, unknown>>
      for (const r of batch) {
        rows.push({
          phone_number: (r.phone_number as string) ?? "",
          first_name: (r.first_name as string) ?? null,
          last_name: (r.last_name as string) ?? null,
          opted_out: (r.opted_out as boolean) ?? false,
        })
      }
      if (batch.length < pageSize) break
    }
    return buildContactList(rows)
  }

  // type === "users": fetch from the users table
  let query = supabase.from("users").select("phone, first_name:name, last_name")

  if (spec.roles && spec.roles.length > 0) {
    query = query.in("role", spec.roles)
  }
  if (spec.userIds && spec.userIds.length > 0) {
    query = query.in("id", spec.userIds)
  }

  const { data, error } = await query
  if (error) throw error

  // Map user rows to the RawContactRow shape
  const rows: RawContactRow[] = (data ?? []).map((u: Record<string, unknown>) => ({
    phone_number: (u.phone as string) ?? "",
    first_name: (u.first_name as string) ?? null,
    last_name: (u.last_name as string) ?? null,
    opted_out: false, // users table has no opted_out flag — honour at contacts level only
  }))

  return buildContactList(rows)
}
