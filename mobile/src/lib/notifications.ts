// In-app notifications feed — the same user-scoped queries the web's
// lib/notification-service.ts runs (RLS already permits client reads).
import { supabase } from "./supabase"

export interface AppNotification {
  id: string
  user_id: string
  title: string
  message: string
  type: string
  read: boolean
  reference_id?: string | null
  action_url?: string | null
  created_at: string
}

export async function listNotifications(limit = 100): Promise<AppNotification[]> {
  const { data: auth } = await supabase.auth.getUser()
  if (!auth.user) return []
  const { data, error } = await supabase
    .from("notifications")
    .select("*")
    .eq("user_id", auth.user.id)
    .order("created_at", { ascending: false })
    .limit(limit)
  if (error) throw error
  return (data ?? []) as AppNotification[]
}

export async function unreadCount(): Promise<number> {
  const { data: auth } = await supabase.auth.getUser()
  if (!auth.user) return 0
  const { count } = await supabase
    .from("notifications")
    .select("id", { count: "exact", head: true })
    .eq("user_id", auth.user.id)
    .eq("read", false)
  return count ?? 0
}

export async function markRead(id: string) {
  await supabase
    .from("notifications")
    .update({ read: true, updated_at: new Date().toISOString() })
    .eq("id", id)
}

export async function markAllRead() {
  const { data: auth } = await supabase.auth.getUser()
  if (!auth.user) return
  await supabase
    .from("notifications")
    .update({ read: true, updated_at: new Date().toISOString() })
    .eq("user_id", auth.user.id)
    .eq("read", false)
}

export async function removeNotification(id: string) {
  await supabase.from("notifications").delete().eq("id", id)
}

export function timeAgo(iso: string): string {
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  if (seconds < 60) return "just now"
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  return new Date(iso).toLocaleDateString()
}

// Ionicons name per notification type (rendered in a tinted circle).
export function notificationIcon(type: string): string {
  switch (type) {
    case "order_update": return "cube-outline"
    case "payment_success": return "card-outline"
    case "balance_updated": return "wallet-outline"
    case "withdrawal_approved": return "checkmark-circle-outline"
    case "withdrawal_rejected": return "close-circle-outline"
    case "complaint_resolved": return "construct-outline"
    default: return "megaphone-outline"
  }
}
