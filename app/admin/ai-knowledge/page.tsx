import { redirect } from "next/navigation"

// Moved into the AI Assistant console (2026-11-21).
export default function AIKnowledgeRedirect() {
  redirect("/admin/ai-assistant?tab=knowledge")
}
