import { NextRequest, NextResponse } from "next/server"
import { confirmDraft } from "@/lib/ai-drafts/confirm"
import { authenticate, isUuid, limitOrNull, notFound, suspendedResponse } from "@/lib/ai-drafts/http"

/** The optional JSON body is only the secure-box values; anything larger is not a legitimate request. */
const MAX_BODY_BYTES = 4096

type BodyResult = { ok: true; secrets: Record<string, string> | undefined } | { ok: false; res: NextResponse }

/** A missing or empty body is `{}`. The secrets are never logged or echoed. */
async function readSecrets(req: NextRequest): Promise<BodyResult> {
  const tooBig = { ok: false as const, res: NextResponse.json({ error: "Request body too large" }, { status: 413 }) }
  const declared = Number(req.headers.get("content-length"))
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return tooBig
  let text = ""
  try {
    text = await req.text()
  } catch {
    return { ok: true, secrets: undefined }
  }
  if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) return tooBig
  if (text.trim() === "") return { ok: true, secrets: undefined }
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return { ok: false, res: NextResponse.json({ error: "Invalid request body", code: "bad_body" }, { status: 400 }) }
  }
  const s = json && typeof json === "object" && !Array.isArray(json) ? (json as Record<string, unknown>).secrets : undefined
  // Shape and values are judged by confirmDraft, and only for admin_route_call drafts.
  return { ok: true, secrets: s && typeof s === "object" && !Array.isArray(s) ? (s as Record<string, string>) : undefined }
}

// POST /api/ai/drafts/[id]/confirm: claim and run the caller's own pending draft. All logic lives in lib/ai-drafts.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticate(req)
  if (!auth.ok) return auth.res
  if (auth.suspended) return suspendedResponse()
  const { id } = await params
  if (!isUuid(id)) return notFound()
  const limited = await limitOrNull(req, "ai_draft_confirm", auth.caller.userId)
  if (limited) return limited

  const body = await readSecrets(req)
  if (!body.ok) return body.res

  try {
    const state = await confirmDraft(auth.db, id, auth.caller, body.secrets)
    if (!state) return notFound()
    if ("refused" in state) return NextResponse.json({ error: state.message, code: state.code }, { status: 400 })
    return NextResponse.json(state)
  } catch {
    console.error("ai_drafts: confirm failed")
    return NextResponse.json({ error: "Something went wrong" }, { status: 500 })
  }
}
