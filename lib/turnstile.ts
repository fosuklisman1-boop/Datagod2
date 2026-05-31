// Server-side verification for Cloudflare Turnstile tokens.
// Read TURNSTILE_SECRET_KEY from env — never log or expose it.

const VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify"

export interface TurnstileResult {
  valid: boolean
  reason?: string
}

export async function verifyTurnstileToken(token: string | undefined | null, remoteIp?: string): Promise<TurnstileResult> {
  if (!token) return { valid: false, reason: "missing_token" }

  const secret = process.env.TURNSTILE_SECRET_KEY
  if (!secret) {
    console.error("[TURNSTILE] TURNSTILE_SECRET_KEY not configured — failing closed")
    return { valid: false, reason: "not_configured" }
  }

  try {
    const formData = new FormData()
    formData.append("secret", secret)
    formData.append("response", token)
    if (remoteIp) formData.append("remoteip", remoteIp)

    const res = await fetch(VERIFY_URL, { method: "POST", body: formData })
    if (!res.ok) return { valid: false, reason: `verify_http_${res.status}` }

    const data = (await res.json()) as { success: boolean; "error-codes"?: string[] }
    if (data.success) return { valid: true }

    const reason = data["error-codes"]?.join(",") || "unknown"
    return { valid: false, reason }
  } catch (e) {
    return { valid: false, reason: e instanceof Error ? e.message : "fetch_failed" }
  }
}

export function getRequestIp(headers: Headers): string | undefined {
  return (
    headers.get("cf-connecting-ip") ||
    headers.get("x-real-ip") ||
    headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    undefined
  )
}
