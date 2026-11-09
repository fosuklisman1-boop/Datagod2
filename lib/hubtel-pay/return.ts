// lib/hubtel-pay/return.ts
// Where a customer lands after Hubtel's hosted checkout (return or cancel). Hubtel's URLs must be on the app host, so
// they point at /api/payments/hubtel-return, which sends the customer on to the page the caller asked for.
//
// The destination comes ONLY from the row (metadata.redirect_url, written by startHostedPayment), never from the
// query, and is re-checked here: https on the app host, the root domain or one of its subdomains (shops), or a
// registered custom domain. Anything else goes to the app home. The signature covers "return:" + ref.
import { verifyReturnSig } from "./client"

type Env = Record<string, string | undefined>

export interface ReturnRow { internal_reference: string | null; metadata: unknown }

export interface ReturnDeps {
  /** Best effort: a slow or failing confirm never holds or stops the redirect. */
  confirm: (reference: string) => Promise<unknown>
  /** Throws on a database error. */
  loadRow: (reference: string) => Promise<ReturnRow | null>
  /** Whether the host is an active registered custom domain. */
  isCustomDomain: (host: string) => Promise<boolean>
  env: Env
}

export type ReturnResult = { kind: "bad_request" } | { kind: "not_configured" } | { kind: "redirect"; url: string }

const CONFIRM_BUDGET_MS = 5_000
const DEFAULT_ROOT = "datagod.store"

function appHome(env: Env): string {
  try {
    const u = new URL(env.NEXT_PUBLIC_APP_URL ?? "")
    if (u.protocol === "https:") return new URL("/", u.origin).toString()
  } catch { /* fall through */ }
  return `https://www.${(env.NEXT_PUBLIC_ROOT_DOMAIN || DEFAULT_ROOT).toLowerCase()}/`
}

/** The stored redirect URL if it is safe to send a customer to, else null. */
export async function safeReturnTarget(raw: unknown, opts: { env: Env; isCustomDomain: (host: string) => Promise<boolean> }): Promise<URL | null> {
  if (typeof raw !== "string" || !raw) return null
  let u: URL
  try { u = new URL(raw) } catch { return null }
  if (u.protocol !== "https:" || u.username || u.password || u.port) return null
  const host = u.hostname.toLowerCase()
  let appHost = ""
  try { appHost = new URL(opts.env.NEXT_PUBLIC_APP_URL ?? "").hostname.toLowerCase() } catch { /* no app host */ }
  const root = (opts.env.NEXT_PUBLIC_ROOT_DOMAIN || DEFAULT_ROOT).toLowerCase()
  if ((appHost && host === appHost) || host === root || host.endsWith(`.${root}`)) return u
  try {
    return (await opts.isCustomDomain(host)) ? u : null
  } catch {
    return null
  }
}

export async function resolveHubtelReturn(
  q: { ref: string | null; sig: string | null; cancelled?: boolean },
  deps: Partial<ReturnDeps> = {},
): Promise<ReturnResult> {
  const env = deps.env ?? process.env
  const secret = env.HUBTEL_PAYMENTS_CALLBACK_SECRET
  if (!secret || secret.length < 32) return { kind: "not_configured" }
  if (!verifyReturnSig(q.ref, q.sig, secret)) return { kind: "bad_request" }
  const ref = q.ref as string
  const d = await resolveDeps(deps, env)
  const home: ReturnResult = { kind: "redirect", url: appHome(env) }

  // `cancelled` changes nothing: a customer can pay and still press cancel, so confirm either way.
  let timer: ReturnType<typeof setTimeout> | undefined
  const confirming = Promise.resolve().then(() => d.confirm(ref)).catch((e) => {
    console.error("[hubtel-return] confirm failed:", e instanceof Error ? e.message : "unknown error")
  })
  await Promise.race([confirming, new Promise<void>((resolve) => { timer = setTimeout(resolve, CONFIRM_BUDGET_MS) })])
  clearTimeout(timer)

  let row: ReturnRow | null
  try {
    row = await d.loadRow(ref)
  } catch (e) {
    console.error("[hubtel-return] row lookup failed:", e instanceof Error ? e.message : "unknown error")
    return home
  }
  if (!row) return home

  const meta = row.metadata && typeof row.metadata === "object" ? (row.metadata as Record<string, unknown>) : {}
  const target = await safeReturnTarget(meta.redirect_url, { env, isCustomDomain: d.isCustomDomain })
  if (!target) return home

  const reference = row.internal_reference ?? ref
  // Same names Paystack's callback uses, so existing confirmation pages read them as they do today.
  target.searchParams.set("reference", reference)
  target.searchParams.set("trxref", reference)
  target.searchParams.set("gateway", "hubtel")
  return { kind: "redirect", url: target.toString() }
}

async function resolveDeps(deps: Partial<ReturnDeps>, env: Env): Promise<ReturnDeps> {
  return {
    env,
    confirm: deps.confirm ?? (async (ref) => (await import("./confirm")).confirmHubtelPayment(ref)),
    loadRow: deps.loadRow ?? (async (ref) => {
      const { createClient } = await import("@supabase/supabase-js")
      const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
        auth: { autoRefreshToken: false, persistSession: false },
      })
      const { data, error } = await sb.from("hubtel_payments").select("internal_reference, metadata").eq("reference", ref).maybeSingle()
      if (error) throw new Error(`hubtel_payments return lookup failed: ${error.code ?? "no code"}`)
      return (data as ReturnRow | null) ?? null
    }),
    isCustomDomain: deps.isCustomDomain ?? (async (host) => {
      const { resolveCustomDomain } = await import("@/lib/custom-domain-lookup")
      return (await resolveCustomDomain(host)) !== null
    }),
  }
}
