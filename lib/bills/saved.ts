// Saved bill accounts ("Saved meters"): a signed-in user's ECG meters, Ghana Water accounts, TV smartcards and
// broadband accounts, kept so paying again is one tap. Only the details the user already typed are stored;
// nothing here is a verification (every payment still verifies the account with Hubtel first).
// Pure validation/normalisation below; DB access takes the caller's service-role client.
import type { SupabaseClient } from "@supabase/supabase-js"
import { normalizeGhanaPhone } from "@/lib/phone-format"
import { isBillerKey, type BillerKey } from "./billers"

export const SAVED_TABLE = "saved_bill_accounts"
export const MAX_SAVED_PER_USER = 30

export interface SavedBillAccount {
  id: string
  biller: BillerKey
  nickname: string | null
  account: string
  phone: string | null
  email: string | null
  broadband_account: string | null
  meter_type: "prepaid" | "postpaid" | null
  customer_name: string | null
  created_at: string
}

export type SavedInput = Omit<SavedBillAccount, "id" | "created_at">

const text = (v: unknown, max: number): string | null => {
  if (typeof v !== "string") return null
  const t = v.replace(/[\u0000-\u001f\u007f]/g, "").trim()
  return t ? t.slice(0, max) : null
}

/** Validates a save request for the given biller: the same fields the pay flow needs to verify it again. */
export function parseSavedInput(body: Record<string, unknown> | null): { ok: true; value: SavedInput } | { ok: false; error: string } {
  if (!body) return { ok: false, error: "Invalid request" }
  const biller = body.biller
  if (!isBillerKey(biller)) return { ok: false, error: "Unknown biller" }
  const account = text(body.account, 40)?.replace(/\s+/g, "") ?? null
  if (!account || account.length < 4) return { ok: false, error: "Enter the meter or account number" }

  const needsPhone = biller === "ecg" || biller === "ghana_water"
  const rawPhone = text(body.phone, 20)
  const phone = rawPhone ? normalizeGhanaPhone(rawPhone) : null
  if (needsPhone && !phone) return { ok: false, error: "Enter a valid phone number" }

  const email = biller === "ghana_water" ? text(body.email, 120) : null
  if (biller === "ghana_water" && (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) return { ok: false, error: "Enter a valid email" }

  const broadband = biller === "telecel_broadband" ? text(body.broadbandAccount, 40) : null
  if (biller === "telecel_broadband" && (!broadband || broadband.length < 3)) return { ok: false, error: "Enter the broadband account number" }

  const meterType = biller === "ecg" && (body.meterType === "prepaid" || body.meterType === "postpaid") ? body.meterType : null
  return {
    ok: true,
    value: {
      biller, account, phone: needsPhone ? phone : null, email, broadband_account: broadband, meter_type: meterType,
      nickname: text(body.nickname, 40), customer_name: text(body.customerName, 80),
    },
  }
}

const COLUMNS = "id, biller, nickname, account, phone, email, broadband_account, meter_type, customer_name, created_at"

export async function listSaved(db: SupabaseClient, userId: string): Promise<SavedBillAccount[]> {
  const { data, error } = await db.from(SAVED_TABLE).select(COLUMNS).eq("user_id", userId).order("created_at", { ascending: false }).limit(MAX_SAVED_PER_USER)
  if (error) throw error
  return (data ?? []) as SavedBillAccount[]
}

/**
 * Saves (or refreshes) one account. The same biller + account (+ broadband account) is one entry: saving it
 * again updates its nickname/phone/name instead of adding a duplicate. Refuses past MAX_SAVED_PER_USER.
 */
export async function saveAccount(db: SupabaseClient, userId: string, input: SavedInput): Promise<{ ok: true; saved: SavedBillAccount } | { ok: false; status: number; error: string }> {
  const { data: existing, error: findErr } = await db.from(SAVED_TABLE).select("id, nickname, customer_name")
    .eq("user_id", userId).eq("biller", input.biller).eq("account", input.account)
    .eq("broadband_account", input.broadband_account ?? "").maybeSingle()
  if (findErr) throw findErr
  const now = new Date().toISOString()
  const row = { ...input, broadband_account: input.broadband_account ?? "", updated_at: now }
  if (existing) {
    // Keep a nickname/name the user already had when this save doesn't bring one.
    const patch = { ...row, nickname: input.nickname ?? existing.nickname ?? null, customer_name: input.customer_name ?? existing.customer_name ?? null }
    const { data, error } = await db.from(SAVED_TABLE).update(patch).eq("id", existing.id).eq("user_id", userId).select(COLUMNS).single()
    if (error) throw error
    return { ok: true, saved: tidy(data as SavedBillAccount) }
  }
  const { count, error: countErr } = await db.from(SAVED_TABLE).select("id", { count: "exact", head: true }).eq("user_id", userId)
  if (countErr) throw countErr
  if ((count ?? 0) >= MAX_SAVED_PER_USER) return { ok: false, status: 409, error: `You can save up to ${MAX_SAVED_PER_USER}. Delete one first.` }
  const { data, error } = await db.from(SAVED_TABLE).insert({ ...row, user_id: userId }).select(COLUMNS).single()
  if (error) throw error
  return { ok: true, saved: tidy(data as SavedBillAccount) }
}

export async function deleteSaved(db: SupabaseClient, userId: string, id: string): Promise<boolean> {
  const { data, error } = await db.from(SAVED_TABLE).delete().eq("id", id).eq("user_id", userId).select("id")
  if (error) throw error
  return (data?.length ?? 0) > 0
}

/** broadband_account is stored as "" (so the unique key works); the API returns null for "none". */
export function tidy(r: SavedBillAccount): SavedBillAccount {
  return { ...r, broadband_account: r.broadband_account || null }
}
