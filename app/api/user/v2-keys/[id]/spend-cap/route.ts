import { NextRequest, NextResponse } from "next/server"
import { getAdminClient } from "@/lib/api-v2/store"
import type { RpcClient } from "@/lib/api-v2/approvals"
import { getKeySpend, setDeveloperCap } from "@/lib/api-v2/spend-caps"
import { getMoneySettings } from "@/lib/api-v2/spend"

// Dashboard session only. An API key is not a session (getUser rejects it), so a stolen key can never raise a limit.
async function sessionUserId(request: NextRequest): Promise<string | null> {
  const token = request.headers.get("Authorization")?.replace("Bearer ", "")
  if (!token) return null
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data } = await (getAdminClient() as any).auth.getUser(token)
    return typeof data?.user?.id === "string" ? data.user.id : null
  } catch {
    return null
  }
}

const unauthorized = () => NextResponse.json({ error: "Sign in to manage your keys." }, { status: 401, headers: { "Cache-Control": "no-store" } })

/** GET /api/user/v2-keys/[id]/spend-cap - today's spend and this key's daily limit (live keys only). */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const userId = await sessionUserId(request)
  if (!userId) return unauthorized()
  const { id } = await params
  let capsActive = false
  try {
    capsActive = (await getMoneySettings().read()).capsEnabled
  } catch {
    capsActive = false
  }
  const out = await getKeySpend(getAdminClient() as unknown as RpcClient, { userId, keyId: id, capsActive })
  return NextResponse.json(out.body, { status: out.status, headers: { "Cache-Control": "no-store" } })
}

/** PUT /api/user/v2-keys/[id]/spend-cap - body { cap: number | null }; null removes the limit. Audited. */
export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const userId = await sessionUserId(request)
  if (!userId) return unauthorized()
  const { id } = await params
  const body = (await request.json().catch(() => null)) as { cap?: unknown } | null
  if (!body || !("cap" in body)) return NextResponse.json({ error: "Send { cap }.", code: "bad_input" }, { status: 400 })
  const out = await setDeveloperCap(getAdminClient() as unknown as RpcClient, { userId, keyId: id, cap: body.cap })
  return NextResponse.json(out.body, { status: out.status, headers: { "Cache-Control": "no-store" } })
}
