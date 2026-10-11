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
type Result<T> = { ok: true; data: T } | { ok: false; error: string; fields?: Record<string, string>; status?: number }
/** Minimal File shape (a DOM File satisfies it) so the service is testable without multipart. */
export interface UploadedFile { type: string; size: number; arrayBuffer(): Promise<ArrayBuffer> }

export function toPublicKyc(p: KycProfile): PublicKyc {
  const { ghana_card_doc_path, registration_doc_path, ...rest } = p
  return { ...rest, has_ghana_card_doc: !!ghana_card_doc_path, has_registration_doc: !!registration_doc_path }
}

const LOAD_FAILED = "Couldn't load your application, try again."
const TRY_AGAIN = "Something went wrong, please try again."

/** Latest application for an account. THROWS on a DB error — "no row" and "couldn't read" must not look alike. */
export async function getCurrentKyc(accountId: string): Promise<KycProfile | null> {
  const { data, error } = await supabaseAdmin.from("sms_business_profiles").select("*")
    .eq("sms_account_id", accountId).order("created_at", { ascending: false }).limit(1).maybeSingle()
  if (error) {
    console.error("[SMS-KYC] failed to load application:", error.message)
    throw new Error("KYC_LOAD_FAILED")
  }
  return (data as KycProfile | null) ?? null
}

async function loadCurrent(accountId: string): Promise<{ ok: true; data: KycProfile | null } | { ok: false; error: string }> {
  try { return { ok: true, data: await getCurrentKyc(accountId) } } catch { return { ok: false, error: LOAD_FAILED } }
}

/** Save (or start) a draft. A rejected application starts a fresh draft row (history kept). */
export async function saveKycDraft(accountId: string, input: KycDraftInput, retryOnConflict = true): Promise<Result<KycProfile>> {
  const v = validateKycDraft(input)
  if (!v.ok) return { ok: false, error: "Please fix the highlighted fields.", fields: v.errors }
  const loaded = await loadCurrent(accountId)
  if (!loaded.ok) return loaded
  const current = loaded.data
  if (!nextKycStatus(current?.status ?? null, "save")) {
    return { ok: false, error: current?.status === "submitted" ? "Your application is under review." : "Your business is already verified." }
  }
  const now = new Date().toISOString()
  if (current?.status === "draft") {
    const { data, error } = await supabaseAdmin.from("sms_business_profiles")
      .update({ ...v.patch, updated_at: now }).eq("id", current.id).eq("status", "draft").select("*").maybeSingle()
    if (error) { console.error("[SMS-KYC] draft update failed:", error.message); return { ok: false, error: TRY_AGAIN } }
    if (!data) return { ok: false, error: "Your application is under review." }
    return { ok: true, data: data as KycProfile }
  }
  const { data, error } = await supabaseAdmin.from("sms_business_profiles")
    .insert({ ...v.patch, sms_account_id: accountId, status: "draft" }).select("*").single()
  if (error) {
    // A concurrent first save created the draft between our read and insert: re-read and update it.
    if (error.code === "23505" && retryOnConflict) return saveKycDraft(accountId, input, false)
    console.error("[SMS-KYC] draft insert failed:", error.message)
    return { ok: false, error: TRY_AGAIN }
  }
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
  const path = `${accountId}/${kind}-${crypto.randomUUID()}.${t.ext}`
  const { error: upErr } = await supabaseAdmin.storage.from(BUCKET).upload(path, bytes, { contentType: file.type, upsert: false })
  if (upErr) { console.error("[SMS-KYC] upload failed:", upErr.message); return { ok: false, error: "Upload failed, please try again." } }
  const column = kind === "ghana_card" ? "ghana_card_doc_path" : "registration_doc_path"
  const old = draft.data[column]
  const removeNew = async () => {
    const { error: rmErr } = await supabaseAdmin.storage.from(BUCKET).remove([path])
    if (rmErr) console.error("[SMS-KYC] failed to remove an orphaned upload:", rmErr.message)
  }
  // Compare-and-swap on the previous value so two concurrent uploads can't both "win" and orphan a file.
  const base = supabaseAdmin.from("sms_business_profiles")
    .update({ [column]: path, updated_at: new Date().toISOString() }).eq("id", draft.data.id).eq("status", "draft")
  const { data, error } = await (old ? base.eq(column, old) : base.is(column, null)).select("*").maybeSingle()
  if (error) {
    console.error("[SMS-KYC] recording upload failed:", error.message)
    await removeNew()
    return { ok: false, error: TRY_AGAIN }
  }
  if (!data) {
    await removeNew()
    return { ok: false, error: "Please try that upload again." }
  }
  if (old) {
    const { error: rmErr } = await supabaseAdmin.storage.from(BUCKET).remove([old])
    if (rmErr) console.error("[SMS-KYC] failed to remove a replaced document:", rmErr.message)
  }
  return { ok: true, data: data as KycProfile }
}

export async function submitKyc(accountId: string): Promise<Result<KycProfile>> {
  const loaded = await loadCurrent(accountId)
  if (!loaded.ok) return loaded
  const current = loaded.data
  if (!current || !nextKycStatus(current.status, "submit")) return { ok: false, error: "There is no draft to submit." }
  const missing = missingForSubmit(current)
  if (missing.length) return { ok: false, error: `Complete these first: ${missing.join(", ")}.` }
  const { data, error } = await supabaseAdmin.from("sms_business_profiles")
    .update({ status: "submitted", submitted_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", current.id).eq("status", "draft").select("*").maybeSingle()
  if (error) { console.error("[SMS-KYC] submit failed:", error.message); return { ok: false, error: TRY_AGAIN } }
  if (!data) return { ok: false, error: "Your application is already under review." }
  notifyAdminsThrottled("sms_kyc_submitted", "New SMS business verification",
    `${current.business_name} submitted business verification for SMS.`, "/admin/sms", 0).catch(() => {})
  return { ok: true, data: data as KycProfile }
}

export async function listKycForAdmin(status: KycStatus | "all" = "submitted"): Promise<PublicKyc[]> {
  let q = supabaseAdmin.from("sms_business_profiles").select("*").order("submitted_at", { ascending: false, nullsFirst: false }).limit(200)
  if (status !== "all") q = q.eq("status", status)
  const { data, error } = await q
  if (error) throw new Error(`kyc list failed: ${error.message}`)
  return ((data ?? []) as KycProfile[]).map(toPublicKyc)
}

export async function getKycForAdmin(adminId: string, id: string): Promise<(PublicKyc & { ghana_card_doc_url: string | null; registration_doc_url: string | null }) | null> {
  const { data } = await supabaseAdmin.from("sms_business_profiles").select("*").eq("id", id).maybeSingle()
  if (!data) return null
  const p = data as KycProfile
  if (p.ghana_card_doc_path || p.registration_doc_path) {
    // Ids only — never paths or signed URLs.
    writeAuditLog(adminId, "sms_kyc_docs_viewed", null, null, { profile_id: p.id, account_id: p.sms_account_id }).catch(() => {})
  }
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

/**
 * Retry the Business-mode switch for an application that was approved but whose mode change failed.
 * No-op (ok) when the account is already in Business mode. Notifies the owner only on a real switch.
 */
export async function retryKycModeChange(adminId: string | null, profileId: string): Promise<Result<{ mode: string }>> {
  if (!adminId) return NO_ADMIN
  const { data: p, error } = await supabaseAdmin.from("sms_business_profiles").select("id, sms_account_id, status").eq("id", profileId).maybeSingle()
  if (error) { console.error("[SMS-KYC] retry load failed:", error.message); return { ok: false, error: TRY_AGAIN } }
  if (!p) return { ok: false, error: "Application not found.", status: 404 }
  if (p.status !== "approved") return { ok: false, error: "Only approved applications can have their mode change retried.", status: 400 }
  // Always re-run: setAccountMode is idempotent and also unpauses sender IDs still paused.
  const mode = await setAccountMode(adminId, p.sms_account_id, "business")
  if (!mode.ok) return { ok: false, error: mode.error }
  notifyAccountOwner(p.sms_account_id, "Business verified",
    "Your business is verified. You're now in Business mode and can request more sender IDs.").catch(() => {})
  return { ok: true, data: { mode: mode.data.mode } }
}

interface PurgeRow { id: string; ghana_card_doc_path: string | null; registration_doc_path: string | null }
const HAS_DOC = "ghana_card_doc_path.not.is.null,registration_doc_path.not.is.null"

/**
 * Delete documents once docs_purge_after has passed (decided applications), and from abandoned drafts
 * untouched for 30 days. Submitted rows are never touched. Logs ids only, never paths.
 */
export async function purgeKycDocuments(now = new Date()): Promise<{ purged: number; errors: number }> {
  let purged = 0, errors = 0
  const decided = await supabaseAdmin.from("sms_business_profiles")
    .select("id, ghana_card_doc_path, registration_doc_path").lt("docs_purge_after", now.toISOString()).or(HAS_DOC).limit(200)
  const stale = await supabaseAdmin.from("sms_business_profiles")
    .select("id, ghana_card_doc_path, registration_doc_path").eq("status", "draft")
    .lt("updated_at", new Date(now.getTime() - PURGE_AFTER_MS).toISOString()).or(HAS_DOC).limit(200)
  const cutoff = new Date(now.getTime() - PURGE_AFTER_MS).toISOString()
  for (const res of [decided, stale]) {
    if (res.error) { errors++; console.error("[SMS-KYC] purge select failed:", res.error.message); continue }
    const isStaleDrafts = res === stale
    for (const row of (res.data ?? []) as PurgeRow[]) {
      const paths = [row.ghana_card_doc_path, row.registration_doc_path].filter((p): p is string => !!p)
      if (isStaleDrafts) {
        // Clear the paths FIRST, guarded on the exact state we read, so a concurrent upload or submit
        // wins and its files are never deleted. Files are removed only if this update matched.
        const base = supabaseAdmin.from("sms_business_profiles").update({ ghana_card_doc_path: null, registration_doc_path: null })
          .eq("id", row.id).eq("status", "draft").lt("updated_at", cutoff)
        const g = row.ghana_card_doc_path ? base.eq("ghana_card_doc_path", row.ghana_card_doc_path) : base.is("ghana_card_doc_path", null)
        const guarded = row.registration_doc_path ? g.eq("registration_doc_path", row.registration_doc_path) : g.is("registration_doc_path", null)
        const { data: cleared, error: clrErr } = await guarded.select("id")
        if (clrErr) { errors++; console.error(`[SMS-KYC] purge db update failed for profile ${row.id}:`, clrErr.message); continue }
        if (!cleared || cleared.length === 0) continue // changed since we read it — leave it alone
        const { error: rmErr } = await supabaseAdmin.storage.from(BUCKET).remove(paths)
        if (rmErr) { errors++; console.error(`[SMS-KYC] purge storage remove failed for profile ${row.id} (files orphaned):`, rmErr.message); continue }
        purged++
        continue
      }
      const { error } = await supabaseAdmin.storage.from(BUCKET).remove(paths)
      if (error) { errors++; console.error(`[SMS-KYC] purge storage remove failed for profile ${row.id}:`, error.message); continue }
      const { error: upErr } = await supabaseAdmin.from("sms_business_profiles").update({ ghana_card_doc_path: null, registration_doc_path: null }).eq("id", row.id)
      if (upErr) { errors++; console.error(`[SMS-KYC] purge db update failed for profile ${row.id}:`, upErr.message); continue }
      purged++
    }
  }
  return { purged, errors }
}
