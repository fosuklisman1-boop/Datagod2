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
    const { data, error } = await supabase
      .from("sms_contacts")
      .select("phone_number, first_name, last_name, opted_out")
      .eq("group_id", spec.groupId)

    if (error) throw error
    return buildContactList(data ?? [])
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
