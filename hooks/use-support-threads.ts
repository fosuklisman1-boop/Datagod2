"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { supabase } from "@/lib/supabase"
import {
  countUnreadByThread,
  mergeMessage,
  mergeThread,
  realtimeReceipt,
  receiptPlan,
  type ClientMessage,
  type ClientThread,
} from "@/lib/support-client"

const THREAD_COLUMNS = "id, order_id, shop_order_id, subject, category, status, last_message_at, created_at"
// Explicit list: the admin receipt columns are never requested.
const MESSAGE_COLUMNS = "id, thread_id, sender_role, body, attachment_path, delivered_to_user_at, read_by_user_at, created_at"
const MESSAGES_PER_THREAD = 500

async function accessToken(): Promise<string | null> {
  const { data } = await supabase.auth.getSession()
  return data.session?.access_token ?? null
}

function cleanThread(row: ClientThread): ClientThread {
  return {
    id: row.id,
    order_id: row.order_id ?? null,
    shop_order_id: row.shop_order_id ?? null,
    subject: row.subject,
    category: row.category,
    status: row.status,
    last_message_at: row.last_message_at,
    created_at: row.created_at,
  }
}

export function useSupportThreads(userId: string | undefined) {
  const [threads, setThreads] = useState<ClientThread[]>([])
  const [messagesByThread, setMessagesByThread] = useState<Record<string, ClientMessage[]>>({})
  const [unreadByThread, setUnreadByThread] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const threadIdsRef = useRef<Set<string>>(new Set())
  const messagesRef = useRef<Record<string, ClientMessage[]>>({})
  const openIdRef = useRef<string | null>(null)

  useEffect(() => {
    messagesRef.current = messagesByThread
  }, [messagesByThread])

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
        setUnreadByThread({})
      } else {
        // Lightweight: only the thread id of each unread support-side message.
        const { data: u, error: uErr } = await supabase
          .from("support_messages")
          .select("thread_id")
          .in("thread_id", list.map((x) => x.id))
          .neq("sender_role", "user")
          .is("read_by_user_at", null)
          .limit(5000)
        if (uErr) throw new Error(uErr.message)
        setUnreadByThread(countUnreadByThread((u ?? []) as { thread_id: string }[]))
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

  /** Receipt UPDATEs, always scoped to support-side messages and guarded by IS NULL. */
  const markDeliveredByThread = useCallback(async (threadId: string) => {
    await supabase
      .from("support_messages")
      .update({ delivered_to_user_at: new Date().toISOString() })
      .eq("thread_id", threadId)
      .neq("sender_role", "user")
      .is("delivered_to_user_at", null)
  }, [])

  const markReadByThread = useCallback(async (threadId: string) => {
    await supabase
      .from("support_messages")
      .update({ read_by_user_at: new Date().toISOString() })
      .eq("thread_id", threadId)
      .neq("sender_role", "user")
      .is("read_by_user_at", null)
  }, [])

  const applyThreadReceipts = useCallback(
    async (threadId: string) => {
      const plan = receiptPlan(messagesRef.current[threadId] ?? [])
      if (!plan.markRead && !plan.markDelivered) return
      const now = new Date().toISOString()
      setMessagesByThread((prev) => ({
        ...prev,
        [threadId]: (prev[threadId] ?? []).map((m) =>
          m.sender_role !== "user"
            ? { ...m, read_by_user_at: m.read_by_user_at ?? now, delivered_to_user_at: m.delivered_to_user_at ?? now }
            : m,
        ),
      }))
      setUnreadByThread((prev) => ({ ...prev, [threadId]: 0 }))
      // Delivered first so a message is never "read" without having been delivered.
      if (plan.markDelivered) await markDeliveredByThread(threadId)
      if (plan.markRead) await markReadByThread(threadId)
    },
    [markDeliveredByThread, markReadByThread],
  )

  useEffect(() => {
    if (!userId) return
    // Unique per mount so a strict-mode remount cannot collide with a channel still closing.
    const channel = supabase
      .channel(`support-user-${userId}-${Math.random().toString(36).slice(2, 10)}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "support_messages" },
        (payload) => {
          const row = payload.new as ClientMessage
          if (!threadIdsRef.current.has(row.thread_id)) return
          const decision = realtimeReceipt({
            senderRole: row.sender_role,
            threadOpen: openIdRef.current === row.thread_id,
            tabVisible: typeof document === "undefined" || document.visibilityState === "visible",
          })
          const now = new Date().toISOString()
          const clean: ClientMessage = {
            id: row.id,
            thread_id: row.thread_id,
            sender_role: row.sender_role,
            body: row.body,
            attachment_path: row.attachment_path ?? null,
            delivered_to_user_at: row.delivered_to_user_at ?? (decision === "none" ? null : now),
            read_by_user_at: row.read_by_user_at ?? (decision === "read" ? now : null),
            created_at: row.created_at,
          }
          setMessagesByThread((prev) => ({
            ...prev,
            // A thread that was never opened has no loaded history; it is fetched on open.
            ...(prev[clean.thread_id] ? { [clean.thread_id]: mergeMessage(prev[clean.thread_id], clean) } : {}),
          }))
          if (decision === "none") return
          if (decision === "delivered") {
            setUnreadByThread((prev) => ({ ...prev, [clean.thread_id]: (prev[clean.thread_id] ?? 0) + 1 }))
          }
          void (async () => {
            await supabase
              .from("support_messages")
              .update({ delivered_to_user_at: now })
              .eq("id", clean.id)
              .is("delivered_to_user_at", null)
            if (decision === "read") {
              await supabase
                .from("support_messages")
                .update({ read_by_user_at: now })
                .eq("id", clean.id)
                .is("read_by_user_at", null)
            }
          })()
        },
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "support_threads", filter: `user_id=eq.${userId}` },
        (payload) => {
          const row = cleanThread(payload.new as ClientThread)
          threadIdsRef.current.add(row.id)
          setThreads((prev) => mergeThread(prev, row))
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
  }, [userId])

  // Coming back to the tab with a thread open: mark what arrived meanwhile as read.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible" && openIdRef.current) void applyThreadReceipts(openIdRef.current)
    }
    document.addEventListener("visibilitychange", onVisible)
    return () => document.removeEventListener("visibilitychange", onVisible)
  }, [applyThreadReceipts])

  const openThread = useCallback(
    async (id: string) => {
      openIdRef.current = id
      // Newest 500, fetched descending then flipped to read order.
      const { data, error: mErr } = await supabase
        .from("support_messages")
        .select(MESSAGE_COLUMNS)
        .eq("thread_id", id)
        .order("created_at", { ascending: false })
        .limit(MESSAGES_PER_THREAD)
      if (mErr) {
        setError(mErr.message)
        return
      }
      const fetched = ((data ?? []) as ClientMessage[]).slice().reverse()
      // Fold into any Realtime arrivals so nothing is lost or duplicated.
      let merged = messagesRef.current[id] ?? []
      for (const m of fetched) merged = mergeMessage(merged, m)
      messagesRef.current = { ...messagesRef.current, [id]: merged }
      setMessagesByThread((prev) => ({ ...prev, [id]: merged }))
      if (document.visibilityState === "visible") await applyThreadReceipts(id)
    },
    [applyThreadReceipts],
  )

  /** No thread is on screen any more (back to the list, or leaving the page). */
  const closeThread = useCallback(() => {
    openIdRef.current = null
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

  return { threads, messagesByThread, unreadByThread, openThread, closeThread, sendMessage, reload: load, loading, error }
}
