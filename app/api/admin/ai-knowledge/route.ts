import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyAdminAccess } from "@/lib/admin-auth"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function GET(req: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(req)
  if (!isAdmin) return errorResponse

  const { data, error } = await supabase
    .from("ai_knowledge")
    .select("*")
    .order("category")
    .order("created_at", { ascending: false })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ entries: data })
}

export async function POST(req: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(req)
  if (!isAdmin) return errorResponse

  const body = await req.json()
  const { category, question, answer, contexts } = body

  if (!question?.trim() || !answer?.trim()) {
    return NextResponse.json({ error: "question and answer are required" }, { status: 400 })
  }

  const { data, error } = await supabase
    .from("ai_knowledge")
    .insert({
      category: category?.trim() || "faq",
      question: question.trim(),
      answer: answer.trim(),
      contexts: contexts ?? ["storefront", "dashboard", "admin"],
      updated_at: new Date().toISOString(),
    })
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ entry: data })
}

export async function PATCH(req: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(req)
  if (!isAdmin) return errorResponse

  const body = await req.json()
  const { id, ...fields } = body

  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 })

  const { data, error } = await supabase
    .from("ai_knowledge")
    .update({ ...fields, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ entry: data })
}

export async function DELETE(req: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(req)
  if (!isAdmin) return errorResponse

  const id = new URL(req.url).searchParams.get("id")
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 })

  const { error } = await supabase.from("ai_knowledge").delete().eq("id", id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ success: true })
}
