/**
 * Per-tenant SMS templates (the composer's "Save as template" + "Message
 * Templates" list). Scoped to the owning sms_account_id so each shop sees only
 * its own templates (admin-global templates have sms_account_id IS NULL).
 *
 * Service-role only; called from tenant routes after auth + account resolution.
 */

import { createClient } from "@supabase/supabase-js"

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export interface TenantTemplate {
  id: string
  name: string
  body: string
  created_at: string
  updated_at: string
}

type Result<T> = { ok: true; data: T } | { ok: false; error: string }

/** List the account's own templates, newest first. */
export async function listTenantTemplates(accountId: string): Promise<Result<TenantTemplate[]>> {
  const { data, error } = await supabaseAdmin
    .from("sms_templates")
    .select("id, name, body, created_at, updated_at")
    .eq("sms_account_id", accountId)
    .order("created_at", { ascending: false })

  if (error) return { ok: false, error: error.message }
  return { ok: true, data: (data ?? []) as TenantTemplate[] }
}

/** Create a template owned by the account. Name 1..100, body 1..1000. */
export async function createTenantTemplate(
  accountId: string,
  name: string,
  body: string
): Promise<Result<TenantTemplate>> {
  const n = (name ?? "").trim()
  const b = (body ?? "").trim()
  if (n.length < 1 || n.length > 100) return { ok: false, error: "Template name must be 1–100 characters" }
  if (b.length < 1 || b.length > 1000) return { ok: false, error: "Template body must be 1–1000 characters" }

  const { data, error } = await supabaseAdmin
    .from("sms_templates")
    .insert({ name: n, body: b, sms_account_id: accountId })
    .select("id, name, body, created_at, updated_at")
    .single()

  if (error) return { ok: false, error: error.message }
  return { ok: true, data: data as TenantTemplate }
}

/** Delete one of the account's own templates (scoped so a tenant can't delete another's). */
export async function deleteTenantTemplate(accountId: string, templateId: string): Promise<Result<{ id: string }>> {
  const { data, error } = await supabaseAdmin
    .from("sms_templates")
    .delete()
    .eq("id", templateId)
    .eq("sms_account_id", accountId)
    .select("id")

  if (error) return { ok: false, error: error.message }
  if (!data || data.length === 0) return { ok: false, error: "Template not found" }
  return { ok: true, data: { id: templateId } }
}
