/**
 * KYC (business verification) — spec §5.6. Private bucket `sms-kyc`; admins see documents via
 * 5-minute signed URLs; files are deleted 30 days after the decision (purgeKycDocuments).
 * Approval switches the account to Business mode and unpauses its sender IDs.
 *
 * Privacy: the Ghana Card number is never stored (last 4 only). Document paths and signed URLs
 * are never logged, put in notifications, or returned to customers (see toPublicKyc).
 */
import { createClient } from "@supabase/supabase-js"
import { docExtension, matchesDocSignature, missingForSubmit, nextKycStatus, validateKycDraft, type KycDraftInput, type KycStatus } from "./kyc-rules"
import { setAccountMode } from "./sender-rules-service"
import { notifyAdminsThrottled } from "./notify"
import { writeAuditLog } from "./moderation-service"

const supabaseAdmin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
const BUCKET = "sms-kyc"
const PURGE_AFTER_MS = 30 * 86_400_000
const NO_ADMIN = { ok: false, error: "Admin user required" } as const

export interface KycProfile {
  id: string; sms_account_id: string; business_name: string | null; description: string | null; website: string | null
  whatsapp_number: string | null; ghana_card_last4: string | null; ghana_card_doc_path: string | null
  registration_doc_path: string | null; status: KycStatus; submitted_at: string | null; reviewed_at: string | null
  rejection_reason: string | null; created_at: string
}
/** What customers and admin lists see: document paths replaced by booleans. */
export type PublicKyc = Omit<KycProfile, "ghana_card_doc_path" | "registration_doc_path"> & {
  has_ghana_card_doc: boolean; has_registration_doc: boolean
}
type Result<T> = { ok: true; data: T } | { ok: false; error: string; fields?: Record<string, string> }
/** Minimal File shape (a DOM File satisfies it) so the service is testable without multipart. */
export interface UploadedFile { type: string; size: number; arrayBuffer(): Promise<ArrayBuffer> }

export function toPublicKyc(p: KycProfile): PublicKyc {
  const { ghana_card_doc_path, registration_doc_path, ...rest } = p
  return { ...rest, has_ghana_card_doc: !!ghana_card_doc_path, has_registration_doc: !!registration_doc_path }
}

export async function getCurrentKyc(accountId: string): Promise<KycProfile | null> {
  const { data } = await supabaseAdmin.from("sms_business_profiles").select("*")
    .eq("sms_account_id", accountId).order("created_at", { ascending: false }).limit(1).maybeSingle()
  return (data as KycProfile | null) ?? null
}

/** Save (or start) a draft. A rejected application starts a fresh draft row (history kept). */
export async function saveKycDraft(accountId: string, input: KycDraftInput): Promise<Result<KycProfile>> {
  const v = validateKycDraft(input)
  if (!v.ok) return { ok: false, error: "Please fix the highlighted fields.", fields: v.errors }
  const current = await getCurrentKyc(accountId)
  if (!nextKycStatus(current?.status ?? null, "save")) {
    return { ok: false, error: current?.status === "submitted" ? "Your application is under review." : "Your business is already verified." }
  }
  const now = new Date().toISOString()
  const q = current?.status === "draft"
    ? supabaseAdmin.from("sms_business_profiles").update({ ...v.patch, updated_at: now }).eq("id", current.id).eq("status", "draft")
    : supabaseAdmin.from("sms_business_profiles").insert({ ...v.patch, sms_account_id: accountId, status: "draft" })
  const { data, error } = await q.select("*").single()
  if (error) return { ok: false, error: error.message }
  return { ok: true, data: data as KycProfile }
}

export async function uploadKycDocument(accountId: string, kind: "ghana_card" | "registration", file: UploadedFile): Promise<Result<KycProfile>> {
  const t = docExtension(file.type, file.size)
  if (!t.ok) return { ok: false, error: t.error }
  const bytes = new Uint8Array(await file.arrayBuffer())
  // Re-check against the real byte length and content: the declared size/type are client-supplied.
  const real = docExtension(file.type, bytes.byteLength)
  if (!real.ok) return { ok: false, error: real.error }
  if (!matchesDocSignature(file.type, bytes)) return { ok: false, error: "That file doesn't look like a valid JPG, PNG, WEBP or PDF." }
  const draft = await saveKycDraft(accountId, {})
  if (!draft.ok) return draft
  const path = `${accountId}/${kind}-${Date.now()}.${t.ext}`
  const { error: upErr } = await supabaseAdmin.storage.from(BUCKET).upload(path, bytes, { contentType: file.type, upsert: false })
  if (upErr) return { ok: false, error: `Upload failed: ${upErr.message}` }
  const column = kind === "ghana_card" ? "ghana_card_doc_path" : "registration_doc_path"
  const old = draft.data[column]
  const { data, error } = await supabaseAdmin.from("sms_business_profiles")
    .update({ [column]: path, updated_at: new Date().toISOString() }).eq("id", draft.data.id).eq("status", "draft").select("*").single()
  if (error) {
    await supabaseAdmin.storage.from(BUCKET).remove([path])
    return { ok: false, error: error.message }
  }
  if (old) {
    const { error: rmErr } = await supabaseAdmin.storage.from(BUCKET).remove([old])
    if (rmErr) console.error("[SMS-KYC] failed to remove a replaced document:", rmErr.message)
  }
  return { ok: true, data: data as KycProfile }
}

export async function submitKyc(accountId: string): Promise<Result<KycProfile>> {
  const current = await getCurrentKyc(accountId)
  if (!current || !nextKycStatus(current.status, "submit")) return { ok: false, error: "There is no draft to submit." }
  const missing = missingForSubmit(current)
  if (missing.length) return { ok: false, error: `Complete these first: ${missing.join(", ")}.` }
  const { data, error } = await supabaseAdmin.from("sms_business_profiles")
    .update({ status: "submitted", submitted_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", current.id).eq("status", "draft").select("*").single()
  if (error) return { ok: false, error: error.message }
  notifyAdminsThrottled("sms_kyc_submitted", "New SMS business verification",
    `${current.business_name} submitted business verification for SMS.`, "/admin/sms", 0).catch(() => {})
  return { ok: true, data: data as KycProfile }
}

export async function listKycForAdmin(status: KycStatus | "all" = "submitted"): Promise<PublicKyc[]> {
  let q = supabaseAdmin.from("sms_business_profiles").select("*").order("submitted_at", { ascending: false, nullsFirst: false }).limit(200)
  if (status !== "all") q = q.eq("status", status)
  const { data } = await q
  return ((data ?? []) as KycProfile[]).map(toPublicKyc)
}

export async function getKycForAdmin(id: string): Promise<(PublicKyc & { ghana_card_doc_url: string | null; registration_doc_url: string | null }) | null> {
  const { data } = await supabaseAdmin.from("sms_business_profiles").select("*").eq("id", id).maybeSingle()
  if (!data) return null
  const p = data as KycProfile
  const sign = async (path: string | null) => {
    if (!path) return null
    const { data: s } = await supabaseAdmin.storage.from(BUCKET).createSignedUrl(path, 300)
    return s?.signedUrl ?? null
  }
  return { ...toPublicKyc(p), ghana_card_doc_url: await sign(p.ghana_card_doc_path), registration_doc_url: await sign(p.registration_doc_path) }
}

async function notifyAccountOwner(accountId: string, title: string, message: string) {
  const { data: a } = await supabaseAdmin.from("sms_accounts").select("user_id").eq("id", accountId).maybeSingle()
  if (!a?.user_id) return
  const now = new Date().toISOString()
  await supabaseAdmin.from("notifications").insert({ user_id: a.user_id, title, message, type: "sms_kyc", read: false, action_url: "/dashboard/sms", created_at: now, updated_at: now })
}

async function decide(adminId: string, id: string, outcome: "approved" | "rejected", reason?: string): Promise<Result<KycProfile>> {
  const now = new Date()
  const { data, error } = await supabaseAdmin.from("sms_business_profiles")
    .update({
      status: outcome, reviewed_by: adminId, reviewed_at: now.toISOString(),
      rejection_reason: outcome === "rejected" ? reason : null,
      docs_purge_after: new Date(now.getTime() + PURGE_AFTER_MS).toISOString(), updated_at: now.toISOString(),
    })
    .eq("id", id).eq("status", "submitted").select("*").maybeSingle()
  if (error || !data) return { ok: false, error: error?.message ?? "Only submitted applications can be decided." }
  writeAuditLog(adminId, `sms_kyc_${outcome}`, null, { id, status: "submitted" }, { id, status: outcome, reason: reason ?? null }).catch(() => {})
  return { ok: true, data: data as KycProfile }
}

type ModeChange = { ok: true; mode: string } | { ok: false; error: string }

/**
 * Approve = record the decision, THEN switch the account to Business mode. The decision stands even
 * if the mode change fails; callers must check `modeChange` (the admin can retry via the account route).
 */
export async function approveKyc(adminId: string | null, id: string): Promise<Result<KycProfile & { modeChange: ModeChange }>> {
  if (!adminId) return NO_ADMIN
  const r = await decide(adminId, id, "approved")
  if (!r.ok) return r
  const mode = await setAccountMode(adminId, r.data.sms_account_id, "business")
  if (mode.ok) {
    notifyAccountOwner(r.data.sms_account_id, "Business verified",
      "Your business is verified. You're now in Business mode and can request more sender IDs.").catch(() => {})
  }
  return { ok: true, data: { ...r.data, modeChange: mode.ok ? { ok: true, mode: mode.data.mode } : { ok: false, error: mode.error } } }
}

export async function rejectKyc(adminId: string | null, id: string, reason: string): Promise<Result<KycProfile>> {
  if (!adminId) return NO_ADMIN
  const why = (reason ?? "").trim()
  if (why.length < 5) return { ok: false, error: "A rejection reason (5+ characters) is required." }
  const r = await decide(adminId, id, "rejected", why)
  if (r.ok) notifyAccountOwner(r.data.sms_account_id, "Business verification not approved",
    `Reason: ${why}. You can update your details and submit again.`).catch(() => {})
  return r
}

/** Delete decided applications' documents once docs_purge_after has passed. */
export async function purgeKycDocuments(now = new Date()): Promise<{ purged: number; errors: number }> {
  const { data } = await supabaseAdmin.from("sms_business_profiles")
    .select("id, ghana_card_doc_path, registration_doc_path").lt("docs_purge_after", now.toISOString())
    .or("ghana_card_doc_path.not.is.null,registration_doc_path.not.is.null").limit(200)
  let purged = 0, errors = 0
  for (const row of (data ?? []) as { id: string; ghana_card_doc_path: string | null; registration_doc_path: string | null }[]) {
    const paths = [row.ghana_card_doc_path, row.registration_doc_path].filter((p): p is string => !!p)
    const { error } = await supabaseAdmin.storage.from(BUCKET).remove(paths)
    if (error) { errors++; continue }
    const { error: upErr } = await supabaseAdmin.from("sms_business_profiles").update({ ghana_card_doc_path: null, registration_doc_path: null }).eq("id", row.id)
    if (upErr) { errors++; continue }
    purged++
  }
  return { purged, errors }
}
