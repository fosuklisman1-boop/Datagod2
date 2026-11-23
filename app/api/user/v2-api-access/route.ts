import { after, NextRequest, NextResponse } from "next/server"
import { applyRateLimit } from "@/lib/rate-limiter"
import { requireCapability } from "@/lib/roles/require-capability"
import { canRequestKey } from "@/lib/api-v2/eligibility"
import { MSG_V2_NOT_OPEN } from "@/lib/api-v2/key-issue"
import { getAdminClient, getConfig, hasGrant } from "@/lib/api-v2/store"
import { cancelAccessRequest, createAccessRequest } from "@/lib/api-v2/access-requests"
import { alertAdminsOfRequest, notifyUserOfOutcome } from "@/lib/admin-actions"

// Service-role client; callers are authenticated via their session bearer token. The user id always comes from
// that session, never from the request body.
const client = getAdminClient()
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const authClient = client as any

const RETRY = "Couldn't check your access. Please try again."

async function getSessionUser(request: NextRequest): Promise<{ id: string } | null> {
  const token = request.headers.get("Authorization")?.replace("Bearer ", "")
  if (!token) return null
  const { data } = await authClient.auth.getUser(token)
  return data?.user ?? null
}

/** The account.api capability: "no" is a definite answer, "error" means the check itself failed. */
async function apiCapability(userId: string): Promise<"yes" | "no" | "error"> {
  const denied = await requireCapability(client, userId, "account.api")
  if (!denied) return "yes"
  return denied.status === 403 ? "no" : "error"
}

async function readCaller(userId: string): Promise<{ role: string; suspended: boolean; label: string } | null> {
  try {
    const { data, error } = await client
      .from("users")
      .select("role, is_suspended, email, first_name, last_name")
      .eq("id", userId)
      .maybeSingle()
    if (error || !data) return null
    const email = typeof data.email === "string" && data.email ? data.email : null
    const name = [data.first_name, data.last_name].filter((s) => typeof s === "string" && s.trim()).join(" ").trim()
    return {
      role: typeof data.role === "string" ? data.role : "",
      suspended: Boolean(data.is_suspended),
      label: name && email ? `${name} (${email})` : name || email || "A user",
    }
  } catch {
    return null
  }
}

/**
 * POST /api/user/v2-api-access - ask for API access (design section 5B). Approval is an admin decision; this
 * only records the request, returns its code for the WhatsApp message, and alerts admins.
 */
export async function POST(request: NextRequest) {
  const sessionUser = await getSessionUser(request)
  if (!sessionUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const perUser = await applyRateLimit(request, "api_v2_access_request", 5, 60 * 60 * 1000, sessionUser.id)
  if (!perUser.allowed) return NextResponse.json({ error: "Too many requests" }, { status: 429 })
  const perIp = await applyRateLimit(request, "api_v2_access_request_ip", 10, 60 * 60 * 1000)
  if (!perIp.allowed) return NextResponse.json({ error: "Too many requests from this network. Please slow down." }, { status: 429 })

  const caller = await readCaller(sessionUser.id)
  if (!caller) return NextResponse.json({ error: RETRY }, { status: 503 })
  const config = await getConfig(client)
  if (!config.enabled) return NextResponse.json({ error: MSG_V2_NOT_OPEN }, { status: 503 })
  if (caller.suspended) return NextResponse.json({ error: "This account is suspended" }, { status: 403 })

  // "Already eligible" uses the key-creation rule (role AND capability, or a grant), so an allowed role that
  // lacks account.api can still ask. The grant is read only when the role and capability alone don't settle it.
  const capability = await apiCapability(sessionUser.id)
  if (capability === "error") return NextResponse.json({ error: RETRY }, { status: 503 })
  const base = { role: caller.role, allowedRoles: config.allowed_roles, hasApiCapability: capability === "yes" }
  let eligible = canRequestKey({ ...base, hasGrant: false })
  if (!eligible) {
    const granted = await hasGrant(client, sessionUser.id)
    if (granted === "error") return NextResponse.json({ error: RETRY }, { status: 503 })
    eligible = granted
  }
  if (eligible) return NextResponse.json({ error: "Your account can already create API keys." }, { status: 409 })

  const created = await createAccessRequest(client, sessionUser.id, new Date())
  if (!created.ok) {
    if (created.status === 409) return NextResponse.json({ error: "You already have an open API access request." }, { status: 409 })
    if (created.status === 429) {
      return NextResponse.json({ error: "Your last request was not approved. You can ask again later.", retryAt: created.retryAt }, { status: 429 })
    }
    return NextResponse.json({ error: "Could not send your request. Please try again." }, { status: 500 })
  }

  if (created.alert) {
    const work = async () => {
      try {
        await alertAdminsOfRequest("api_access", { kind: "access", code: created.code, who: caller.label })
        await notifyUserOfOutcome("api_access", "requested", { userId: sessionUser.id, reference: created.code }, { kind: "access", code: created.code })
      } catch {
        // notifications never undo or fail the request
      }
    }
    // After the response; without a request scope (tests) it runs unawaited.
    try {
      after(work)
    } catch {
      void work()
    }
  }
  return NextResponse.json({ id: created.id, code: created.code, status: "pending" }, { status: 201 })
}

/** DELETE /api/user/v2-api-access - cancel the caller's own open request. */
export async function DELETE(request: NextRequest) {
  const sessionUser = await getSessionUser(request)
  if (!sessionUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const r = await cancelAccessRequest(client, sessionUser.id)
  if (r === "cancelled") return NextResponse.json({ message: "Request cancelled" })
  if (r === "none") return NextResponse.json({ error: "No open request" }, { status: 404 })
  return NextResponse.json({ error: "Could not cancel the request" }, { status: 500 })
}
