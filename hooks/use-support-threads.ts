"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { supabase } from "@/lib/supabase"
import { mergeMessage, type ClientMessage, type ClientThread } from "@/lib/support-client"

const THREAD_COLUMNS = "id, order_id, shop_order_id, subject, category, status, last_message_at, created_at"
// Explicit list: the admin receipt columns are never requested.
const MESSAGE_COLUMNS = "id, thread_id, sender_role, body, attachment_path, delivered_to_user_at, read_by_user_at, created_at"

async function accessToken(): Promise<string | null> {
  const { data } = await supabase.auth.getSession()
  return data.session?.access_token ?? null
}

export function useSupportThreads(userId: string | undefined) {
  const [threads, setThreads] = useState<ClientThread[]>([])
  const [messagesByThread, setMessagesByThread] = useState<Record<string, ClientMessage[]>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const threadIdsRef = useRef<Set<string>>(new Set())

  const load = useCallback(async () => {
    if (!userId) return
    try {
      setLoading(true)
      const { data: t, error: tErr } = await supabase
        .from("support_threads")
        .select(THREAD_COLUMNS)
        .eq("user_id", userId)
        .order("last_message_at", { ascending: false })
        .limit(100)
      if (tErr) throw new Error(tErr.message)
      const list = (t ?? []) as ClientThread[]
      threadIdsRef.current = new Set(list.map((x) => x.id))
      setThreads(list)

      if (list.length === 0) {
        setMessagesByThread({})
      } else {
        const { data: m, error: mErr } = await supabase
          .from("support_messages")
          .select(MESSAGE_COLUMNS)
          .in("thread_id", list.map((x) => x.id))
          .order("created_at", { ascending: true })
          .limit(2000)
        if (mErr) throw new Error(mErr.message)
        const grouped: Record<string, ClientMessage[]> = {}
        for (const row of (m ?? []) as ClientMessage[]) {
          ;(grouped[row.thread_id] ??= []).push(row)
        }
        setMessagesByThread(grouped)
      }
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load your conversations")
    } finally {
      setLoading(false)
    }
  }, [userId])

  useEffect(() => {
    load()
  }, [load])

  const markDelivered = useCallback(async (messageId: string) => {
    const now = new Date().toISOString()
    await supabase
      .from("support_messages")
      .update({ delivered_to_user_at: now })
      .eq("id", messageId)
      .is("delivered_to_user_at", null)
  }, [])

  useEffect(() => {
    if (!userId) return
    const channel = supabase
      .channel(`support-user-${userId}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "support_messages" },
        (payload) => {
          const row = payload.new as ClientMessage
          if (!threadIdsRef.current.has(row.thread_id)) return
          const clean: ClientMessage = {
            id: row.id,
            thread_id: row.thread_id,
            sender_role: row.sender_role,
            body: row.body,
            attachment_path: row.attachment_path ?? null,
            delivered_to_user_at: row.delivered_to_user_at ?? null,
            read_by_user_at: row.read_by_user_at ?? null,
            created_at: row.created_at,
          }
          setMessagesByThread((prev) => ({
            ...prev,
            [clean.thread_id]: mergeMessage(prev[clean.thread_id] ?? [], clean),
          }))
          if (clean.sender_role !== "user") void markDelivered(clean.id)
        },
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "support_threads", filter: `user_id=eq.${userId}` },
        (payload) => {
          const row = payload.new as ClientThread
          if (!threadIdsRef.current.has(row.id)) return
          setThreads((prev) =>
            prev
              .map((t) =>
                t.id === row.id
                  ? { ...t, status: row.status, last_message_at: row.last_message_at, subject: row.subject }
                  : t,
              )
              .sort((a, b) => b.last_message_at.localeCompare(a.last_message_at)),
          )
        },
      )
      .subscribe()
    return () => {
      void supabase.removeChannel(channel)
    }
  }, [userId, markDelivered])

  const openThread = useCallback(async (id: string) => {
    const now = new Date().toISOString()
    setMessagesByThread((prev) => ({
      ...prev,
      [id]: (prev[id] ?? []).map((m) =>
        m.sender_role !== "user"
          ? { ...m, read_by_user_at: m.read_by_user_at ?? now, delivered_to_user_at: m.delivered_to_user_at ?? now }
          : m,
      ),
    }))
    await supabase
      .from("support_messages")
      .update({ read_by_user_at: now, delivered_to_user_at: now })
      .eq("thread_id", id)
      .neq("sender_role", "user")
      .is("read_by_user_at", null)
  }, [])

  const sendMessage = useCallback(async (id: string, text: string) => {
    const token = await accessToken()
    if (!token) throw new Error("Please sign in again")
    const res = await fetch(`/api/support/threads/${id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ message: text }),
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok || !json?.success) {
      if (res.status === 409) throw new Error("This complaint is closed. Start a new one.")
      if (res.status === 429) throw new Error("You are sending messages too fast. Wait a moment.")
      throw new Error(json?.error || "Message could not be sent")
    }
    const sent: ClientMessage = {
      id: json.data.id,
      thread_id: id,
      sender_role: "user",
      body: text,
      attachment_path: null,
      delivered_to_user_at: null,
      read_by_user_at: null,
      created_at: json.data.created_at,
    }
    setMessagesByThread((prev) => ({ ...prev, [id]: mergeMessage(prev[id] ?? [], sent) }))
    setThreads((prev) =>
      prev
        .map((t) => (t.id === id ? { ...t, last_message_at: sent.created_at } : t))
        .sort((a, b) => b.last_message_at.localeCompare(a.last_message_at)),
    )
  }, [])

  return { threads, messagesByThread, openThread, sendMessage, reload: load, loading, error }
}
