import { redirect } from "next/navigation"

// Moved into the AI Assistant console (2026-11-21).
export default function AISettingsRedirect() {
  redirect("/admin/ai-assistant?tab=settings")
}
