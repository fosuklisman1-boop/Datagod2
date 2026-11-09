// Storefront sub-agent join: new accounts (intent stored at sign-up, finalized when the email link is clicked) and
// logged-in customers (upgraded on the spot). Callers pass the service-role client as `db`; the anon client is only
// used for auth.signUp so Supabase sends its normal confirmation email.
//
// Role and parent never come from user_metadata or the request body: the parent is resolved server-side from the
// handle (route) or from the intent row (finalize), and the role is written here.
// Logs carry codes and messages only: no phones, emails or passwords.
//
// Binding to the confirmation email: each intent stores the SHA-256 of a random nonce whose raw value only travels in
// that sign-up's emailRedirectTo (`/auth/callback?join=<nonce>`). finalizeJoinIntent runs only from /auth/confirm for
// a signup confirmation, only with the matching nonce, only for an email-only account and within 24 hours, so a
// later magic link, Google sign-in or email change can never attach someone's join intent to an account.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { createSubAgentShop, ensureWallet, makeShopSlug, SubAgentSlugTakenError } from "./create-shop"
import { joinerStatus, targetStatus } from "./join-eligibility"
import { notifyOwnerOfRecruit } from "./notify-owner"
import { provisionShopCode } from "@/lib/ussd-shop/provision-code"

type Db = any

export const JOIN_SETUP_TARGET = "/dashboard/shop-pricing?setup=1"
export const JOIN_CLOSED_TARGET = "/dashboard?join=closed"
export const LOGIN_TO_CONTINUE = "You already have an account. Log in to continue joining."

const OTP_PROOF_WINDOW_MS = 30 * 60 * 1000
const SLUG_ATTEMPTS = 5
/** signUp also returns an existing unconfirmed account; one created longer ago than this wasn't made by this request. */
const FRESH_ACCOUNT_MS = 10 * 60 * 1000
/** An intent older than this is never finalized. */
const INTENT_TTL_MS = 24 * 60 * 60 * 1000
/** A consumed intent answers repeat confirmations for this long, then stops affecting redirects. */
const CONSUMED_ANSWER_MS = 60 * 60 * 1000

const sha256Hex = (s: string) => createHash("sha256").update(s).digest("hex")

function nonceMatches(nonce: string | null | undefined, storedHash: unknown): boolean {
  if (typeof nonce !== "string" || nonce === "" || typeof storedHash !== "string" || storedHash === "") return false
  const a = Buffer.from(sha256Hex(nonce), "utf8")
  const b = Buffer.from(storedHash, "utf8")
  return a.length === b.length && timingSafeEqual(a, b)
}

export type TargetShop = {
  id: string
  shop_name: string
  tier_level: number | null
  is_active: boolean
  is_blocked: boolean
  parent_shop_id: string | null
}

export type JoinOutcome = { httpStatus: number; body: Record<string, unknown> }

const fail = (httpStatus: number, error: string, extra: Record<string, unknown> = {}): JoinOutcome => ({
  httpStatus,
  body: { error, ...extra },
})

function logErr(where: string, e: any): void {
  console.error(`[SUB-AGENT-JOIN] ${where}:`, e?.code ?? "", e?.message ?? "")
}

// ---------------------------------------------------------------------------
// Phone and shop name

/** The local 10-digit form (0XXXXXXXXX). 241234567, 0241234567, 233241234567 and +233 24 123 4567 are one number. */
export function normalizePhone(raw: string): string {
  let d = String(raw ?? "").replace(/\D/g, "")
  if (d.length === 12 && d.startsWith("233")) d = d.slice(3)
  if (d.length === 9) d = `0${d}`
  return d
}

const isLocalPhone = (p: string) => /^0\d{9}$/.test(p)

/** Every form the same number may have been stored in (users.phone_number and OTP rows keep what was typed). */
export function phoneVariants(raw: string): string[] {
  const ten = normalizePhone(raw)
  const nine = ten.slice(1)
  const typed = String(raw ?? "").trim()
  return [...new Set([ten, nine, `233${nine}`, `+233${nine}`, typed].filter(Boolean))]
}

/** Collapses runs of whitespace and trims. */
export function cleanShopName(name: unknown): string {
  return typeof name === "string" ? name.replace(/\s+/g, " ").trim() : ""
}

/**
 * Error message, or null when the name is acceptable: letters, digits, spaces and ' & - . only, 3 to 40 characters,
 * no URL or domain, no run of 7+ digits (owner alerts carry this name, so it must not work as a link or a phone number).
 */
export function validateRecruitShopName(name: string): string | null {
  const n = cleanShopName(name)
  if (n.length < 3 || n.length > 40) return "Shop name must be 3 to 40 characters."
  if (/:\/\//.test(n) || /www\./i.test(n) || /[A-Za-z0-9]\.[A-Za-z]{2,}/.test(n)) {
    return "Shop name can't be a web address."
  }
  if (/\d{7,}/.test(n)) return "Shop name can't contain a phone number."
  if (!/^[A-Za-z0-9 '&.\-]+$/.test(n)) return "Shop name can only use letters, numbers, spaces and ' & - ."
  return null
}

// ---------------------------------------------------------------------------
// Shared reads

/** app_settings.sub_agent_open_join_enabled on the singleton row. A missing column (0146 not applied) means off. */
export async function readOpenJoinEnabled(db: Db): Promise<boolean> {
  try {
    const { data, error } = await db
      .from("app_settings")
      .select("sub_agent_open_join_enabled")
      .is("key", null)
      .maybeSingle()
    if (error) return false
    return (data as { sub_agent_open_join_enabled?: boolean } | null)?.sub_agent_open_join_enabled === true
  } catch {
    return false
  }
}

async function loadTargetShop(db: Db, shopId: string): Promise<TargetShop | null> {
  const { data, error } = await db
    .from("user_shops")
    .select("id, shop_name, tier_level, is_active, is_blocked, parent_shop_id")
    .eq("id", shopId)
    .maybeSingle()
  if (error) throw error
  return (data as TargetShop | null) ?? null
}

async function readOwnShop(db: Db, userId: string): Promise<{ id: string; parent_shop_id: string | null; joined_via: string | null } | null> {
  const { data, error } = await db
    .from("user_shops")
    .select("id, parent_shop_id, joined_via")
    .eq("user_id", userId)
    .maybeSingle()
  if (error) throw error
  return data ?? null
}

async function readUserRow(db: Db, userId: string): Promise<{ id: string; role: string | null; phone_number: string | null } | null> {
  const { data, error } = await db
    .from("users")
    .select("id, role, phone_number")
    .eq("id", userId)
    .maybeSingle()
  if (error) throw error
  return data ?? null
}

/** Is this number registered to anyone other than `exceptUserId`, in any stored form? */
async function phoneTaken(db: Db, phone: string, exceptUserId?: string): Promise<boolean> {
  let q = db.from("users").select("id").in("phone_number", phoneVariants(phone))
  if (exceptUserId) q = q.neq("id", exceptUserId)
  const { data, error } = await q.limit(1)
  if (error) throw error
  return Array.isArray(data) && data.length > 0
}

// ---------------------------------------------------------------------------
// Becoming a sub-agent (shared by finalize and the logged-in upgrade)

class RoleUpdateError extends Error {
  constructor() {
    super("Role update did not apply")
    this.name = "RoleUpdateError"
  }
}

async function createShopWithSlugRetry(db: Db, userId: string, parent: TargetShop, shopName: string) {
  for (let i = 0; i < SLUG_ATTEMPTS; i++) {
    try {
      return await createSubAgentShop(db, {
        userId,
        parent: { id: parent.id, shop_name: parent.shop_name, tier_level: parent.tier_level ?? 1 },
        shopName,
        shopSlug: makeShopSlug(shopName),
        via: "storefront",
        dealerRatesEnabled: false,
      })
    } catch (e) {
      if (e instanceof SubAgentSlugTakenError && i < SLUG_ATTEMPTS - 1) continue
      throw e
    }
  }
  throw new SubAgentSlugTakenError()
}

/**
 * Creates the closed storefront shop, then sets role sub_agent only where it is currently 'user' (deleting the new
 * shop if that does not apply), then the USSD code and the owner alert. A shop that already existed (concurrent
 * double submit) is left untouched and nothing else is written.
 */
async function becomeSubAgent(
  db: Db,
  opts: { userId: string; currentRole: string; parent: TargetShop; shopName: string }
): Promise<void> {
  const { userId, currentRole, parent, shopName } = opts
  const shop = await createShopWithSlugRetry(db, userId, parent, shopName)
  if (!shop.created) return

  if (currentRole !== "sub_agent") {
    const { data, error } = await db
      .from("users")
      .update({ role: "sub_agent", updated_at: new Date().toISOString() })
      .eq("id", userId)
      .eq("role", "user")
      .select("id")
    if (error || !Array.isArray(data) || data.length === 0) {
      if (error) logErr("role update failed", error)
      const { error: delErr } = await db.from("user_shops").delete().eq("id", shop.shopId)
      if (delErr) logErr("shop rollback failed", delErr)
      throw new RoleUpdateError()
    }
  }

  // Same call as /api/admin/users/update-role so the session's user_metadata.role stays in step.
  try {
    const { error: metaErr } = await db.auth.admin.updateUserById(userId, { user_metadata: { role: "sub_agent" } })
    if (metaErr) logErr("auth metadata sync failed", metaErr)
  } catch (e) {
    logErr("auth metadata sync failed", e)
  }

  try {
    await provisionShopCode(db, shop.shopId)
  } catch (e) {
    // The shop is real; the code can still be activated from the dashboard.
    logErr("USSD code provisioning failed", e)
  }

  await notifyOwnerOfRecruit(db, parent.id, shopName)
}

// ---------------------------------------------------------------------------
// New accounts

export interface StartJoinInput {
  /** Anon-key client, used only for auth.signUp (so Supabase sends the confirmation email). */
  anon: { auth: { signUp: (args: any) => Promise<{ data: any; error: any }> } }
  /** Site origin for the confirmation link (`${origin}/auth/callback`). */
  origin: string
  parentShopId: string
  // Straight from the request body: each must be a string or the request gets 400.
  firstName: unknown
  lastName: unknown
  email: unknown
  phone: unknown
  password: unknown
  shopName: unknown
}

const providersOf = (user: any): string[] | undefined =>
  Array.isArray(user?.identities) ? user.identities.map((i: any) => String(i?.provider ?? "")) : undefined

function looksAlreadyRegistered(error: any): boolean {
  return (
    error?.code === "user_already_exists" ||
    error?.code === "email_exists" ||
    /already (been )?registered|already exists/i.test(String(error?.message ?? ""))
  )
}

/**
 * Logged-out join: checks the phone OTP proof, refuses a registered phone, signs up (email confirmation) and stores
 * the join intent. No shop, code or role change happens until the email link is clicked (finalizeJoinIntent).
 */
export async function startJoinIntent(db: Db, input: StartJoinInput): Promise<JoinOutcome> {
  const fields = [input.firstName, input.lastName, input.email, input.phone, input.password, input.shopName]
  if (!fields.every((f) => typeof f === "string")) return fail(400, "Please fill in every field.")
  const rawPhone = input.phone as string
  const firstName = (input.firstName as string).trim()
  const lastName = (input.lastName as string).trim()
  const email = (input.email as string).trim().toLowerCase()
  const password = input.password as string
  const shopName = cleanShopName(input.shopName)
  const phone = normalizePhone(rawPhone)

  if (!firstName || !lastName || firstName.length > 50 || lastName.length > 50) {
    return fail(400, "Enter your first and last name.")
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return fail(400, "Enter a valid email address.")
  if (password.length < 6 || password.length > 72) return fail(400, "Password must be 6 to 72 characters.")
  if (!isLocalPhone(phone)) return fail(400, "Enter a valid phone number.")
  const nameError = validateRecruitShopName(shopName)
  if (nameError) return fail(400, nameError)

  // Proof the phone was verified with a code (same rule as /api/auth/signup), in any stored form.
  const since = new Date(Date.now() - OTP_PROOF_WINDOW_MS).toISOString()
  const { data: proof, error: proofErr } = await db
    .from("phone_otp_verifications")
    .select("id")
    .in("phone", phoneVariants(rawPhone))
    .eq("purpose", "signup")
    .eq("used", true)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()
  if (proofErr) {
    logErr("OTP proof lookup failed", proofErr)
    return fail(500, "Something went wrong. Please try again.")
  }
  if (!proof) return fail(400, "Verify your phone number with the code we sent before joining.")

  // Only reached with a verified code for this phone, so it reveals nothing to someone who doesn't own the number.
  try {
    if (await phoneTaken(db, phone)) return fail(409, LOGIN_TO_CONTINUE, { status: "login_required" })
  } catch (e) {
    logErr("phone lookup failed", e)
    return fail(500, "Something went wrong. Please try again.")
  }

  // The raw nonce exists only in this confirmation link; the intent stores its hash.
  const nonce = randomBytes(32).toString("base64url")
  const nonceHash = sha256Hex(nonce)

  const { data, error } = await input.anon.auth.signUp({
    email,
    password,
    options: {
      emailRedirectTo: `${input.origin}/auth/callback?join=${nonce}`,
      data: { first_name: firstName, last_name: lastName },
    },
  })
  if (error) {
    if (looksAlreadyRegistered(error)) return fail(409, LOGIN_TO_CONTINUE, { status: "login_required" })
    logErr("sign-up failed", error)
    if (error?.code === "weak_password") return fail(400, "Choose a stronger password.")
    return fail(400, "We couldn't create your account. Please check your details and try again.")
  }
  const user = data?.user
  if (!user?.id) return fail(500, "We couldn't create your account. Please try again.")
  // Supabase's anti-enumeration answer for an already confirmed email: a user with no identities, and no email sent.
  if (Array.isArray(user.identities) && user.identities.length === 0) {
    return fail(409, LOGIN_TO_CONTINUE, { status: "login_required" })
  }

  // Keeps the existing intent's details and points it at the confirmation email just sent (the newest link), so a
  // double submit can still be finalized. Only an unconsumed intent; a wrong caller learns nothing (nonce never returned).
  const rotateNonce = async (): Promise<JoinOutcome> => {
    const { error: rotErr } = await db
      .from("sub_agent_join_intents")
      .update({ nonce_hash: nonceHash })
      .eq("user_id", user.id)
      .is("consumed_at", null)
    if (rotErr) {
      logErr("intent nonce update failed", rotErr)
      return fail(500, "Something went wrong. Please try again.")
    }
    return { httpStatus: 200, body: { status: "confirm_email" } }
  }
  const readPrior = async () => {
    const { data: prior, error: priorErr } = await db
      .from("sub_agent_join_intents")
      .select("user_id")
      .eq("user_id", user.id)
      .maybeSingle()
    if (priorErr) throw priorErr
    return prior
  }

  // An older unconfirmed account (someone's earlier normal sign-up) returns here too. Never attach a join intent,
  // with this caller's phone and parent, to an account this request didn't just create. A missing or unparseable
  // created_at counts as not fresh.
  const createdAt = Date.parse(typeof user.created_at === "string" ? user.created_at : "")
  if (!Number.isFinite(createdAt) || Date.now() - createdAt > FRESH_ACCOUNT_MS) {
    try {
      if (!(await readPrior())) return fail(409, LOGIN_TO_CONTINUE, { status: "login_required" })
    } catch (e) {
      logErr("intent lookup failed", e)
      return fail(500, "Something went wrong. Please try again.")
    }
    return rotateNonce()
  }

  const { error: intentErr } = await db.from("sub_agent_join_intents").insert({
    user_id: user.id,
    parent_shop_id: input.parentShopId,
    shop_name: shopName,
    first_name: firstName,
    last_name: lastName,
    phone,
    nonce_hash: nonceHash,
    otp_verification_id: (proof as { id: string }).id,
  })
  if (intentErr) {
    if (intentErr.code !== "23505") {
      logErr("intent insert failed", intentErr)
      return fail(500, "Something went wrong. Please try again.")
    }
    // 23505 is either this account's own intent (double submit: keep the first) or the phone proof already backing
    // another account's intent (one proof, one intent).
    try {
      if (!(await readPrior())) return fail(400, "Verify your phone number again before joining.")
    } catch (e) {
      logErr("intent lookup failed", e)
      return fail(500, "Something went wrong. Please try again.")
    }
    const rotated = await rotateNonce()
    if (rotated.httpStatus !== 200) return rotated
  }

  // Email confirmation switched off: there will be no link to click, so finalize now.
  if (data?.session) {
    const done = await finalizeJoinIntent(db, user.id, { email, nonce, identities: providersOf(user) })
    return { httpStatus: 200, body: { status: "joined", target: done?.target ?? JOIN_CLOSED_TARGET } }
  }

  return { httpStatus: 200, body: { status: "confirm_email" } }
}

/** Fills the users row from the intent. Inserts it (role 'user') when the handle_new_user trigger didn't. Never
 *  changes the role, and only sets a phone where none is stored. */
async function writeProfile(
  db: Db,
  userId: string,
  p: { email?: string; firstName: string | null; lastName: string | null; phone: string | null }
): Promise<void> {
  const existing = await readUserRow(db, userId)
  const now = new Date().toISOString()
  if (!existing) {
    const { error } = await db.from("users").insert({
      id: userId,
      email: p.email ?? "",
      first_name: p.firstName ?? "",
      last_name: p.lastName ?? "",
      phone_number: p.phone,
      phone_verified: !!p.phone,
      role: "user",
      updated_at: now,
    })
    if (!error) return
    if (error.code !== "23505") throw error
  }
  const patch: Record<string, unknown> = { first_name: p.firstName ?? "", last_name: p.lastName ?? "", updated_at: now }
  if (p.phone && !existing?.phone_number) {
    patch.phone_number = p.phone
    patch.phone_verified = true
  }
  const { error } = await db.from("users").update(patch).eq("id", userId)
  if (error) throw error
}

async function targetForConsumed(db: Db, userId: string): Promise<{ target: string }> {
  const shop = await readOwnShop(db, userId)
  return { target: shop?.joined_via === "storefront" ? JOIN_SETUP_TARGET : JOIN_CLOSED_TARGET }
}

export interface FinalizeJoinOpts {
  email?: string
  /** Raw nonce from the confirmation link; finalize refuses without a match. */
  nonce?: string | null
  /** Identity providers of the auth user; anything but exactly email-only is refused. */
  identities?: string[]
}

/**
 * Runs when a signup confirmation link carrying a join nonce is clicked (/auth/confirm via resolvePostAuthRedirect).
 * null when there is no intent, the nonce doesn't match, the account has a non-email identity or the intent is over
 * 24 hours old: those never touch the account. Otherwise claims the intent once (consumed_at set conditionally),
 * re-checks the target shop and the phone, writes the users row and wallet, and creates the shop, USSD code and
 * owner alert. A repeat within an hour of consumption returns the same target; after that, null.
 */
export async function finalizeJoinIntent(
  db: Db,
  userId: string,
  opts: FinalizeJoinOpts = {}
): Promise<{ target: string } | null> {
  const { data: intent, error } = await db
    .from("sub_agent_join_intents")
    .select("user_id, parent_shop_id, shop_name, first_name, last_name, phone, nonce_hash, created_at, consumed_at")
    .eq("user_id", userId)
    .maybeSingle()
  if (error) {
    // Includes the table not existing yet (0146 unapplied): carry on with normal signup.
    logErr("intent read failed", error)
    return null
  }
  if (!intent) return null
  if (!nonceMatches(opts.nonce, intent.nonce_hash)) return null
  const ids = opts.identities
  if (!Array.isArray(ids) || ids.length === 0 || ids.some((p) => p !== "email")) return null

  if (intent.consumed_at) {
    const consumedAt = Date.parse(intent.consumed_at)
    if (!Number.isFinite(consumedAt) || Date.now() - consumedAt > CONSUMED_ANSWER_MS) return null
    return targetForConsumed(db, userId)
  }
  const createdAt = Date.parse(intent.created_at)
  if (!Number.isFinite(createdAt) || Date.now() - createdAt > INTENT_TTL_MS) return null

  const { data: claimed, error: claimErr } = await db
    .from("sub_agent_join_intents")
    .update({ consumed_at: new Date().toISOString() })
    .eq("user_id", userId)
    .eq("nonce_hash", intent.nonce_hash)
    .is("consumed_at", null)
    .select("user_id")
  if (claimErr) throw claimErr
  if (!Array.isArray(claimed) || claimed.length === 0) return targetForConsumed(db, userId)

  try {
    const [enabled, parent] = await Promise.all([readOpenJoinEnabled(db), loadTargetShop(db, intent.parent_shop_id)])
    const phone = normalizePhone(intent.phone)
    const taken = !isLocalPhone(phone) || (await phoneTaken(db, phone, userId))

    await writeProfile(db, userId, {
      email: opts.email,
      firstName: intent.first_name,
      lastName: intent.last_name,
      phone: taken ? null : phone,
    })
    await ensureWallet(db, userId)

    if (taken || !parent || targetStatus(parent, enabled) !== "open") return { target: JOIN_CLOSED_TARGET }

    const [user, ownShop] = await Promise.all([readUserRow(db, userId), readOwnShop(db, userId)])
    const role = user?.role ?? "user"
    const status = joinerStatus({ role, hasShop: !!ownShop })
    if (status === "has_shop") return { target: ownShop?.joined_via === "storefront" ? JOIN_SETUP_TARGET : JOIN_CLOSED_TARGET }
    if (status === "not_allowed") return { target: JOIN_CLOSED_TARGET }

    await becomeSubAgent(db, { userId, currentRole: role, parent, shopName: intent.shop_name })
    return { target: JOIN_SETUP_TARGET }
  } catch (e) {
    // Release the claim so a later attempt can finish; the steps above are safe to repeat.
    const { error: relErr } = await db
      .from("sub_agent_join_intents")
      .update({ consumed_at: null })
      .eq("user_id", userId)
    if (relErr) logErr("intent release failed", relErr)
    throw e
  }
}

// ---------------------------------------------------------------------------
// Logged-in customers

/**
 * Logged-in upgrade: no phone code (they already have an account). `parent` must already be resolved from the handle
 * and checked open by the caller. Dealers, admins and shop owners are refused with no writes.
 */
export async function joinExistingUser(
  db: Db,
  opts: { userId: string; parent: TargetShop; shopName: string }
): Promise<JoinOutcome> {
  const shopName = cleanShopName(opts.shopName)
  const nameError = validateRecruitShopName(shopName)
  if (nameError) return fail(400, nameError)

  try {
    const [user, ownShop] = await Promise.all([readUserRow(db, opts.userId), readOwnShop(db, opts.userId)])
    if (!user) return fail(403, "Your account can't join as a sub-agent.")
    const status = joinerStatus({ role: user.role ?? "user", hasShop: !!ownShop })
    if (status === "not_allowed") return fail(403, "Dealer and admin accounts can't join as sub-agents.")
    if (status === "has_shop") {
      // Same join submitted again: answer as before, without touching anything.
      if (ownShop?.joined_via === "storefront" && ownShop.parent_shop_id === opts.parent.id) {
        return { httpStatus: 200, body: { status: "joined", target: JOIN_SETUP_TARGET } }
      }
      return fail(403, "You already have a shop, so you can't join another one.")
    }

    await becomeSubAgent(db, { userId: opts.userId, currentRole: user.role ?? "user", parent: opts.parent, shopName })
    return { httpStatus: 200, body: { status: "joined", target: JOIN_SETUP_TARGET } }
  } catch (e) {
    if (e instanceof RoleUpdateError) return fail(409, "We couldn't update your account. Please try again.")
    logErr("upgrade failed", e)
    return fail(500, "Something went wrong. Please try again.")
  }
}
