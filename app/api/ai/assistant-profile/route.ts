import { NextResponse } from "next/server"
import { DEFAULT_ASSISTANT_NAME } from "@/lib/ai-chat-ui/assistant-name"

// Public, no auth, no DB: the name is the same for everyone. Phase 5 reads an admin setting here.
export async function GET() {
  return NextResponse.json({ name: DEFAULT_ASSISTANT_NAME }, { headers: { "Cache-Control": "public, max-age=60" } })
}
