import { NextRequest, NextResponse } from "next/server"
import { getBillsRuntime } from "@/lib/bills/runtime"
import { authenticate, readJson } from "@/lib/bills/route-auth"
import { deleteSaved, listSaved, parseSavedInput, saveAccount, tidy } from "@/lib/bills/saved"

export const dynamic = "force-dynamic"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const fail = (e: unknown) => {
  console.error("[bills] saved error:", e instanceof Error ? e.message : "error")
  return NextResponse.json({ error: "Could not load saved meters. Please try again." }, { status: 500 })
}

/** The signed-in user's saved meters and accounts. */
export async function GET(request: NextRequest) {
  try {
    const auth = await authenticate(request)
    if ("response" in auth) return auth.response
    const { db } = getBillsRuntime()
    return NextResponse.json({ saved: (await listSaved(db, auth.userId)).map(tidy) })
  } catch (e) { return fail(e) }
}

/** Save (or refresh) one meter/account: { biller, account, phone?, email?, broadbandAccount?, meterType?, nickname?, customerName? }. */
export async function POST(request: NextRequest) {
  try {
    const auth = await authenticate(request)
    if ("response" in auth) return auth.response
    const parsed = parseSavedInput(await readJson(request))
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })
    const { db } = getBillsRuntime()
    const r = await saveAccount(db, auth.userId, parsed.value)
    return r.ok ? NextResponse.json({ saved: r.saved }) : NextResponse.json({ error: r.error }, { status: r.status })
  } catch (e) { return fail(e) }
}

/** Delete one: ?id=<uuid>. Only the owner's own entries can be deleted. */
export async function DELETE(request: NextRequest) {
  try {
    const auth = await authenticate(request)
    if ("response" in auth) return auth.response
    const id = new URL(request.url).searchParams.get("id") ?? ""
    if (!UUID.test(id)) return NextResponse.json({ error: "Invalid id" }, { status: 400 })
    const { db } = getBillsRuntime()
    const removed = await deleteSaved(db, auth.userId, id)
    return removed ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "Not found" }, { status: 404 })
  } catch (e) { return fail(e) }
}
