import { NextRequest, NextResponse } from "next/server"
import { badRequest, gateAdmin, serviceClient, userIdParam, writeAudit, type IdCtx } from "@/lib/admin-users/route-utils"
import { MAX_TAGS_PER_USER, SUGGESTED_TAGS, parseTagsChange } from "@/lib/admin-users/notes-tags"

export const dynamic = "force-dynamic"

/**
 * GET  /api/admin/users/[id]/tags                      -> { tags: string[] (A-Z), suggested: string[] }
 * POST /api/admin/users/[id]/tags { add?, remove? }    -> { tags, changed, audited }
 *      Tags are 1..32 of [a-z0-9-] (trimmed, lower-cased); at most 20 per user. Signed-in admin only (no CRON
 *      bypass). One 'user_tags_change' audit row {tags: before} -> {tags: after, added, removed} when anything
 *      changed. public.admin_user_tags (0149) has RLS on and no policies: only service-role routes reach it.
 */
async function readTags(db: ReturnType<typeof serviceClient>, userId: string) {
  const { data, error } = await db.from("admin_user_tags").select("tag").eq("user_id", userId).order("tag", { ascending: true })
  if (error) throw new Error(error.message)
  return ((data ?? []) as Array<{ tag: string }>).map((r) => r.tag)
}

export async function GET(req: NextRequest, ctx: IdCtx) {
  const gate = await gateAdmin(req)
  if (!gate.ok) return gate.response
  const idp = await userIdParam(ctx)
  if (!idp.ok) return idp.response
  try {
    return NextResponse.json({ tags: await readTags(serviceClient(), idp.id), suggested: SUGGESTED_TAGS })
  } catch (e: any) {
    console.error("[ADMIN-USER-TAGS]", e?.message)
    return NextResponse.json({ error: "Failed to load tags" }, { status: 500 })
  }
}

export async function POST(req: NextRequest, ctx: IdCtx) {
  const gate = await gateAdmin(req, { write: true })
  if (!gate.ok) return gate.response
  const idp = await userIdParam(ctx)
  if (!idp.ok) return idp.response
  const adminId = gate.adminId!

  const parsed = parseTagsChange(await req.json().catch(() => null))
  if (!parsed.ok) return badRequest(parsed.error)
  const { add, remove } = parsed.change

  const db = serviceClient()
  try {
    const before = await readTags(db, idp.id)
    const toAdd = add.filter((t) => !before.includes(t))
    const toRemove = remove.filter((t) => before.includes(t))
    if (before.length + toAdd.length - toRemove.length > MAX_TAGS_PER_USER) {
      return badRequest(`A user can have at most ${MAX_TAGS_PER_USER} tags`)
    }
    if (toAdd.length === 0 && toRemove.length === 0) return NextResponse.json({ tags: before, changed: false, audited: false })

    if (toRemove.length) {
      const { error } = await db.from("admin_user_tags").delete().eq("user_id", idp.id).in("tag", toRemove)
      if (error) throw new Error(error.message)
    }
    if (toAdd.length) {
      const { error } = await db.from("admin_user_tags").upsert(
        toAdd.map((tag) => ({ user_id: idp.id, tag, created_by: adminId })),
        { onConflict: "user_id,tag", ignoreDuplicates: true },
      )
      if (error) {
        if (error.code === "23503") return NextResponse.json({ error: "User not found" }, { status: 404 })
        throw new Error(error.message)
      }
    }
    const after = await readTags(db, idp.id)
    const audited = await writeAudit(db, {
      admin_id: adminId, action: "user_tags_change", target_user_id: idp.id,
      old_value: { tags: before }, new_value: { tags: after, added: toAdd, removed: toRemove },
    })
    return NextResponse.json({ tags: after, changed: true, audited })
  } catch (e: any) {
    console.error("[ADMIN-USER-TAGS] change:", e?.message)
    return NextResponse.json({ error: "Failed to change tags" }, { status: 500 })
  }
}
