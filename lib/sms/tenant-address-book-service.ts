/**
 * Per-tenant SMS address book (groups + contacts), scoped to the owning
 * sms_account_id. Mirrors the per-tenant split already used for templates
 * (tenant-templates-service.ts) and sender IDs: admin-global rows have
 * sms_account_id IS NULL; a tenant only ever sees/mutates its own.
 *
 * Service-role only; called from tenant routes AFTER auth + account resolution.
 * Tenant isolation is enforced HERE (every read/write/delete is constrained to
 * the caller's accountId), NOT via RLS — sms_groups/sms_contacts stay
 * service-role-only (matching 0070/0072/0074). Contacts inherit ownership
 * through their group (sms_contacts has no account column), so EVERY contact
 * op first proves the parent group belongs to the caller's account.
 */

import { createClient } from "@supabase/supabase-js"
import { normalizeGhanaPhone } from "@/lib/phone-format"

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export interface TenantGroup {
  id: string
  name: string
  description: string | null
  created_at: string
  updated_at: string
  contact_count?: number
}

export interface TenantContact {
  id: string
  group_id: string
  first_name: string | null
  last_name: string | null
  phone_number: string
  opted_out: boolean
  verify_status: "unverified" | "pending" | "verified" | "invalid"
  verified_name: string | null
  verified_at: string | null
  created_at: string
}

export interface BulkImportResult {
  inserted: number
  skipped: number
  pendingVerify: number
  skippedSamples: { phone: string; reason: "invalid" | "duplicate" }[]
}

type Result<T> = { ok: true; data: T } | { ok: false; error: string }

const CONTACT_COLS =
  "id, group_id, first_name, last_name, phone_number, opted_out, verify_status, verified_name, verified_at, created_at"

/** Prove a group belongs to the caller's account. Returns true only when the
 *  group exists AND its sms_account_id matches. Every group/contact mutation
 *  gates on this so a tenant can't touch another account's data by id. */
async function ownsGroup(accountId: string, groupId: string): Promise<boolean> {
  const { data } = await supabaseAdmin
    .from("sms_groups")
    .select("id")
    .eq("id", groupId)
    .eq("sms_account_id", accountId)
    .maybeSingle()
  return !!data
}

// ── Groups ──────────────────────────────────────────────────────────────────

/** The account's own groups, newest first, with a derived contact_count. */
export async function listGroups(accountId: string): Promise<Result<TenantGroup[]>> {
  const { data, error } = await supabaseAdmin
    .from("sms_groups")
    .select("id, name, description, created_at, updated_at, contact_count:sms_contacts(count)")
    .eq("sms_account_id", accountId)
    .order("created_at", { ascending: false })

  if (error) return { ok: false, error: error.message }
  // Supabase returns contact_count as [{ count }]; flatten to a number.
  const rows = (data ?? []).map((g: Record<string, unknown>) => ({
    ...g,
    contact_count: Array.isArray(g.contact_count)
      ? ((g.contact_count[0] as { count?: number } | undefined)?.count ?? 0)
      : 0,
  }))
  return { ok: true, data: rows as unknown as TenantGroup[] }
}

/** Create a group owned by the account. Name 1..100. */
export async function createGroup(
  accountId: string,
  name: string,
  description?: string | null
): Promise<Result<TenantGroup>> {
  const n = (name ?? "").trim()
  if (n.length < 1 || n.length > 100) return { ok: false, error: "Group name must be 1–100 characters" }

  const { data, error } = await supabaseAdmin
    .from("sms_groups")
    .insert({ name: n, description: (description ?? null) || null, sms_account_id: accountId })
    .select("id, name, description, created_at, updated_at")
    .single()

  if (error) return { ok: false, error: error.message }
  return { ok: true, data: { ...(data as TenantGroup), contact_count: 0 } }
}

/** A group + its contacts (active first, then newest), scoped to the account. */
export async function getGroupWithContacts(
  accountId: string,
  groupId: string
): Promise<Result<{ group: TenantGroup; contacts: TenantContact[] }>> {
  const { data: group } = await supabaseAdmin
    .from("sms_groups")
    .select("id, name, description, created_at, updated_at")
    .eq("id", groupId)
    .eq("sms_account_id", accountId)
    .maybeSingle()
  if (!group) return { ok: false, error: "Group not found" }

  const { data: contacts, error } = await supabaseAdmin
    .from("sms_contacts")
    .select(CONTACT_COLS)
    .eq("group_id", groupId)
    .order("opted_out", { ascending: true })
    .order("created_at", { ascending: false })

  if (error) return { ok: false, error: error.message }
  return { ok: true, data: { group: group as TenantGroup, contacts: (contacts ?? []) as TenantContact[] } }
}

/** Rename / re-describe one of the account's groups. */
export async function updateGroup(
  accountId: string,
  groupId: string,
  patch: { name?: string; description?: string | null }
): Promise<Result<TenantGroup>> {
  const update: Record<string, unknown> = {}
  if (patch.name !== undefined) {
    const n = patch.name.trim()
    if (n.length < 1 || n.length > 100) return { ok: false, error: "Group name must be 1–100 characters" }
    update.name = n
  }
  if (patch.description !== undefined) update.description = patch.description || null
  if (Object.keys(update).length === 0) return { ok: false, error: "Nothing to update" }
  update.updated_at = new Date().toISOString()

  const { data, error } = await supabaseAdmin
    .from("sms_groups")
    .update(update)
    .eq("id", groupId)
    .eq("sms_account_id", accountId)
    .select("id, name, description, created_at, updated_at")

  if (error) return { ok: false, error: error.message }
  if (!data || data.length === 0) return { ok: false, error: "Group not found" }
  return { ok: true, data: data[0] as TenantGroup }
}

/** Delete one of the account's groups (cascades to its contacts via FK). */
export async function deleteGroup(accountId: string, groupId: string): Promise<Result<{ id: string }>> {
  const { data, error } = await supabaseAdmin
    .from("sms_groups")
    .delete()
    .eq("id", groupId)
    .eq("sms_account_id", accountId)
    .select("id")

  if (error) return { ok: false, error: error.message }
  if (!data || data.length === 0) return { ok: false, error: "Group not found" }
  return { ok: true, data: { id: groupId } }
}

// ── Contacts ──────────────────────────────────────────────────────────────────

/** Add one contact to a group the account owns. */
export async function addContact(
  accountId: string,
  groupId: string,
  contact: { first_name?: string | null; last_name?: string | null; phone_number: string }
): Promise<Result<TenantContact>> {
  if (!(await ownsGroup(accountId, groupId))) return { ok: false, error: "Group not found" }
  const phone = normalizeGhanaPhone(contact.phone_number)
  if (!phone) return { ok: false, error: "Invalid Ghana phone number" }

  const { data, error } = await supabaseAdmin
    .from("sms_contacts")
    .insert({
      group_id: groupId,
      first_name: (contact.first_name ?? null) || null,
      last_name: (contact.last_name ?? null) || null,
      phone_number: phone,
    })
    .select(CONTACT_COLS)
    .single()

  if (error) {
    if (error.code === "23505") return { ok: false, error: "Contact already exists in this group" }
    return { ok: false, error: error.message }
  }
  return { ok: true, data: data as TenantContact }
}

/**
 * Bulk import into a group the account owns. Two-layer dedupe over the
 * UNIQUE(group_id, phone_number) constraint (in-payload Set, then ON CONFLICT
 * DO NOTHING). When verify=true, inserted rows start as 'pending' so the verify
 * drain picks them up; otherwise 'unverified'.
 */
export async function bulkImportContacts(
  accountId: string,
  groupId: string,
  rows: { first_name?: string | null; last_name?: string | null; phone_number: string }[],
  opts?: { verify?: boolean }
): Promise<Result<BulkImportResult>> {
  if (!(await ownsGroup(accountId, groupId))) return { ok: false, error: "Group not found" }

  const verify = opts?.verify === true
  const seen = new Set<string>()
  const toInsert: {
    group_id: string
    first_name: string | null
    last_name: string | null
    phone_number: string
    verify_status: string
  }[] = []
  const skippedSamples: { phone: string; reason: "invalid" | "duplicate" }[] = []
  let skipped = 0
  const sample = (phone: string, reason: "invalid" | "duplicate") => {
    if (skippedSamples.length < 10) skippedSamples.push({ phone, reason })
  }

  for (const row of rows) {
    const phone = normalizeGhanaPhone(row.phone_number)
    if (!phone) {
      skipped++
      sample(String(row.phone_number ?? ""), "invalid")
      continue
    }
    if (seen.has(phone)) {
      skipped++
      sample(phone, "duplicate")
      continue
    }
    seen.add(phone)
    toInsert.push({
      group_id: groupId,
      first_name: (row.first_name ?? null) || null,
      last_name: (row.last_name ?? null) || null,
      phone_number: phone,
      verify_status: verify ? "pending" : "unverified",
    })
  }

  if (toInsert.length === 0) {
    return { ok: true, data: { inserted: 0, skipped, pendingVerify: 0, skippedSamples } }
  }

  const { data, error } = await supabaseAdmin
    .from("sms_contacts")
    .upsert(toInsert, { onConflict: "group_id,phone_number", ignoreDuplicates: true })
    .select("phone_number")

  if (error) return { ok: false, error: error.message }

  const insertedPhones = new Set((data ?? []).map((r: { phone_number: string }) => r.phone_number))
  const inserted = insertedPhones.size
  // Anything we tried to insert that didn't come back collided with an existing row.
  for (const r of toInsert) {
    if (!insertedPhones.has(r.phone_number)) {
      skipped++
      sample(r.phone_number, "duplicate")
    }
  }
  const pendingVerify = verify ? inserted : 0
  return { ok: true, data: { inserted, skipped, pendingVerify, skippedSamples } }
}

/** Resolve a contactId to its group_id only if the account owns that group. Single
 *  query (join), so a non-owned/nonexistent contact id is indistinguishable — no
 *  cross-account existence oracle. */
async function ownedContactGroup(accountId: string, contactId: string): Promise<string | null> {
  const { data } = await supabaseAdmin
    .from("sms_contacts")
    .select("group_id, sms_groups!inner(sms_account_id)")
    .eq("id", contactId)
    .eq("sms_groups.sms_account_id", accountId)
    .maybeSingle()
  return data ? (data as { group_id: string }).group_id : null
}

/** Delete one contact (only within a group the account owns). */
export async function deleteContact(accountId: string, contactId: string): Promise<Result<{ id: string }>> {
  if (!(await ownedContactGroup(accountId, contactId))) return { ok: false, error: "Contact not found" }
  const { error } = await supabaseAdmin.from("sms_contacts").delete().eq("id", contactId)
  if (error) return { ok: false, error: error.message }
  return { ok: true, data: { id: contactId } }
}

/** Opt a contact in/out (only within a group the account owns). */
export async function setContactOptedOut(
  accountId: string,
  contactId: string,
  optedOut: boolean
): Promise<Result<TenantContact>> {
  if (!(await ownedContactGroup(accountId, contactId))) return { ok: false, error: "Contact not found" }
  const { data, error } = await supabaseAdmin
    .from("sms_contacts")
    .update({ opted_out: optedOut })
    .eq("id", contactId)
    .select(CONTACT_COLS)
    .single()
  if (error) return { ok: false, error: error.message }
  return { ok: true, data: data as TenantContact }
}

/**
 * Active, opted-in phone numbers for a group the account owns — used by the
 * group-send path. Opt-out is filtered authoritatively here (server-side), and
 * the list is capped to MAX so a huge group can't blow past the send limit.
 */
export async function getGroupActiveRecipients(
  accountId: string,
  groupId: string,
  max = 500
): Promise<Result<string[]>> {
  if (!(await ownsGroup(accountId, groupId))) return { ok: false, error: "Group not found" }
  const { data, error } = await supabaseAdmin
    .from("sms_contacts")
    .select("phone_number")
    .eq("group_id", groupId)
    .eq("opted_out", false)
    .order("created_at", { ascending: true }) // deterministic which 500 are kept when capped
    .limit(max)
  if (error) return { ok: false, error: error.message }
  const phones = Array.from(new Set((data ?? []).map((r: { phone_number: string }) => r.phone_number)))
  return { ok: true, data: phones }
}
