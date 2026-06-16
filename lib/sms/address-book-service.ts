/**
 * Admin address book for the un-metered broadcast path.
 *
 *   sms_groups    — named contact groups (with a derived contact_count)
 *   sms_contacts  — contacts within a group; phone stored normalised (0XXXXXXXXX),
 *                   deduped per-group by the UNIQUE(group_id, phone_number) constraint
 *   sms_templates — global reusable message templates
 *
 * All access is service-role only; the route-layer verifyAdminAccess is the boundary.
 */

import { createClient } from "@supabase/supabase-js"
import { normalizeGhanaPhone } from "@/lib/phone-format"

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// ---------- Types ----------

export interface SmsGroup {
  id: string
  name: string
  description: string | null
  created_at: string
  updated_at: string
  contact_count?: number
}

export interface SmsContact {
  id: string
  group_id: string
  first_name: string | null
  last_name: string | null
  phone_number: string
  opted_out: boolean
  created_at: string
}

export interface SmsTemplate {
  id: string
  name: string
  body: string
  created_at: string
  updated_at: string
}

export interface BulkImportResult {
  inserted: number
  skipped: number
  skippedSamples: { phone: string; reason: "invalid" | "duplicate" }[]
}

type ServiceResult<T> = { ok: true; data: T } | { ok: false; error: string }

// ---------- Groups ----------

/** List all groups, newest first, each with a derived contact_count. */
export async function listGroups(): Promise<ServiceResult<SmsGroup[]>> {
  const { data, error } = await supabaseAdmin
    .from("sms_groups")
    .select("*, contact_count:sms_contacts(count)")
    .order("created_at", { ascending: false })

  if (error) return { ok: false, error: error.message }

  const groups = (data ?? []).map((g: Record<string, unknown>) => {
    const rel = g.contact_count as { count: number }[] | undefined
    return { ...g, contact_count: rel?.[0]?.count ?? 0 } as SmsGroup
  })
  return { ok: true, data: groups }
}

/** Create a group. Name must be 1..100 chars. */
export async function createGroup(
  name: string,
  description?: string | null
): Promise<ServiceResult<SmsGroup>> {
  const trimmed = (name ?? "").trim()
  if (trimmed.length < 1 || trimmed.length > 100)
    return { ok: false, error: "Group name must be 1–100 characters" }

  const { data, error } = await supabaseAdmin
    .from("sms_groups")
    .insert({ name: trimmed, description: description ?? null })
    .select()
    .single()

  if (error) return { ok: false, error: error.message }
  return { ok: true, data: data as SmsGroup }
}

/** Get one group plus its contacts (active first, then by created_at). */
export async function getGroupWithContacts(
  groupId: string
): Promise<ServiceResult<{ group: SmsGroup; contacts: SmsContact[] }>> {
  const { data: group, error: gErr } = await supabaseAdmin
    .from("sms_groups")
    .select("*")
    .eq("id", groupId)
    .maybeSingle()

  if (gErr) return { ok: false, error: gErr.message }
  if (!group) return { ok: false, error: "Group not found" }

  const { data: contacts, error: cErr } = await supabaseAdmin
    .from("sms_contacts")
    .select("*")
    .eq("group_id", groupId)
    .order("opted_out", { ascending: true })
    .order("created_at", { ascending: true })

  if (cErr) return { ok: false, error: cErr.message }
  return { ok: true, data: { group: group as SmsGroup, contacts: (contacts ?? []) as SmsContact[] } }
}

/** Update a group's name and/or description. */
export async function updateGroup(
  groupId: string,
  patch: { name?: string; description?: string | null }
): Promise<ServiceResult<SmsGroup>> {
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (patch.name !== undefined) {
    const trimmed = patch.name.trim()
    if (trimmed.length < 1 || trimmed.length > 100)
      return { ok: false, error: "Group name must be 1–100 characters" }
    update.name = trimmed
  }
  if (patch.description !== undefined) update.description = patch.description

  const { data, error } = await supabaseAdmin
    .from("sms_groups")
    .update(update)
    .eq("id", groupId)
    .select()
    .maybeSingle()

  if (error) return { ok: false, error: error.message }
  if (!data) return { ok: false, error: "Group not found" }
  return { ok: true, data: data as SmsGroup }
}

/** Delete a group (cascades to its contacts via the FK). */
export async function deleteGroup(groupId: string): Promise<ServiceResult<{ id: string }>> {
  const { error } = await supabaseAdmin.from("sms_groups").delete().eq("id", groupId)
  if (error) return { ok: false, error: error.message }
  return { ok: true, data: { id: groupId } }
}

// ---------- Contacts ----------

/** Add a single contact. Phone is normalised; invalid numbers are rejected. */
export async function addContact(
  groupId: string,
  contact: { first_name?: string | null; last_name?: string | null; phone_number: string }
): Promise<ServiceResult<SmsContact>> {
  const phone = normalizeGhanaPhone(contact.phone_number ?? "")
  if (!phone) return { ok: false, error: "Invalid Ghana phone number" }

  const { data, error } = await supabaseAdmin
    .from("sms_contacts")
    .insert({
      group_id: groupId,
      first_name: contact.first_name ?? null,
      last_name: contact.last_name ?? null,
      phone_number: phone,
    })
    .select()
    .single()

  if (error) {
    // 23505 = unique_violation (already in this group)
    if ((error as { code?: string }).code === "23505")
      return { ok: false, error: "Contact already exists in this group" }
    return { ok: false, error: error.message }
  }
  return { ok: true, data: data as SmsContact }
}

/**
 * Bulk-import rows into a group. Each row's phone is normalised; invalid rows are
 * skipped. Dedupe is two-layered: within the payload (first occurrence wins) and
 * against existing rows via the UNIQUE(group_id, phone_number) constraint
 * (ON CONFLICT DO NOTHING). Returns counts + a small sample of what was skipped.
 */
export async function bulkImportContacts(
  groupId: string,
  rows: { first_name?: string | null; last_name?: string | null; phone_number: string }[]
): Promise<ServiceResult<BulkImportResult>> {
  const skippedSamples: { phone: string; reason: "invalid" | "duplicate" }[] = []
  const seen = new Set<string>()
  const toInsert: { group_id: string; first_name: string | null; last_name: string | null; phone_number: string }[] = []

  const pushSample = (phone: string, reason: "invalid" | "duplicate") => {
    if (skippedSamples.length < 10) skippedSamples.push({ phone, reason })
  }

  let skipped = 0
  for (const row of rows ?? []) {
    const raw = row?.phone_number ?? ""
    const phone = normalizeGhanaPhone(raw)
    if (!phone) {
      skipped++
      pushSample(String(raw), "invalid")
      continue
    }
    if (seen.has(phone)) {
      skipped++
      pushSample(phone, "duplicate")
      continue
    }
    seen.add(phone)
    toInsert.push({
      group_id: groupId,
      first_name: row.first_name ?? null,
      last_name: row.last_name ?? null,
      phone_number: phone,
    })
  }

  if (toInsert.length === 0) {
    return { ok: true, data: { inserted: 0, skipped, skippedSamples } }
  }

  // ignoreDuplicates → ON CONFLICT DO NOTHING; .select() returns only the rows
  // that were actually inserted, so anything missing collided with an existing row.
  const { data, error } = await supabaseAdmin
    .from("sms_contacts")
    .upsert(toInsert, { onConflict: "group_id,phone_number", ignoreDuplicates: true })
    .select("phone_number")

  if (error) return { ok: false, error: error.message }

  const insertedPhones = new Set((data ?? []).map((r: { phone_number: string }) => r.phone_number))
  const inserted = insertedPhones.size
  // Any deduped row that wasn't returned conflicted with an existing DB row.
  for (const r of toInsert) {
    if (!insertedPhones.has(r.phone_number)) {
      skipped++
      pushSample(r.phone_number, "duplicate")
    }
  }

  return { ok: true, data: { inserted, skipped, skippedSamples } }
}

/** Delete a single contact by id. */
export async function deleteContact(contactId: string): Promise<ServiceResult<{ id: string }>> {
  const { error } = await supabaseAdmin.from("sms_contacts").delete().eq("id", contactId)
  if (error) return { ok: false, error: error.message }
  return { ok: true, data: { id: contactId } }
}

/** Toggle a contact's opted_out flag. */
export async function setContactOptedOut(
  contactId: string,
  optedOut: boolean
): Promise<ServiceResult<SmsContact>> {
  const { data, error } = await supabaseAdmin
    .from("sms_contacts")
    .update({ opted_out: optedOut })
    .eq("id", contactId)
    .select()
    .maybeSingle()

  if (error) return { ok: false, error: error.message }
  if (!data) return { ok: false, error: "Contact not found" }
  return { ok: true, data: data as SmsContact }
}

// ---------- Templates ----------

/** List all templates, newest first. */
export async function listTemplates(): Promise<ServiceResult<SmsTemplate[]>> {
  const { data, error } = await supabaseAdmin
    .from("sms_templates")
    .select("*")
    .order("created_at", { ascending: false })

  if (error) return { ok: false, error: error.message }
  return { ok: true, data: (data ?? []) as SmsTemplate[] }
}

/** Create a template. Name 1..100, body 1..1000. */
export async function createTemplate(
  name: string,
  body: string
): Promise<ServiceResult<SmsTemplate>> {
  const n = (name ?? "").trim()
  const b = (body ?? "").trim()
  if (n.length < 1 || n.length > 100) return { ok: false, error: "Template name must be 1–100 characters" }
  if (b.length < 1 || b.length > 1000) return { ok: false, error: "Template body must be 1–1000 characters" }

  const { data, error } = await supabaseAdmin
    .from("sms_templates")
    .insert({ name: n, body: b })
    .select()
    .single()

  if (error) return { ok: false, error: error.message }
  return { ok: true, data: data as SmsTemplate }
}

/** Update a template's name and/or body. */
export async function updateTemplate(
  templateId: string,
  patch: { name?: string; body?: string }
): Promise<ServiceResult<SmsTemplate>> {
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (patch.name !== undefined) {
    const n = patch.name.trim()
    if (n.length < 1 || n.length > 100) return { ok: false, error: "Template name must be 1–100 characters" }
    update.name = n
  }
  if (patch.body !== undefined) {
    const b = patch.body.trim()
    if (b.length < 1 || b.length > 1000) return { ok: false, error: "Template body must be 1–1000 characters" }
    update.body = b
  }

  const { data, error } = await supabaseAdmin
    .from("sms_templates")
    .update(update)
    .eq("id", templateId)
    .select()
    .maybeSingle()

  if (error) return { ok: false, error: error.message }
  if (!data) return { ok: false, error: "Template not found" }
  return { ok: true, data: data as SmsTemplate }
}

/** Delete a template by id. */
export async function deleteTemplate(templateId: string): Promise<ServiceResult<{ id: string }>> {
  const { error } = await supabaseAdmin.from("sms_templates").delete().eq("id", templateId)
  if (error) return { ok: false, error: error.message }
  return { ok: true, data: { id: templateId } }
}
