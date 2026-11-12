"use client"

import { useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { Loader2, MessageSquareText, Plus } from "lucide-react"
import { useAuth } from "@/hooks/use-auth"
import { useSupportThreads } from "@/hooks/use-support-threads"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { DashboardHeroBanner } from "@/components/shared/dashboard-hero-banner"
import { Button } from "@/components/ui/button"
import { ChatPane } from "@/components/support/chat-pane"
import { ContactHub } from "@/components/support/contact-hub"
import { NewComplaintDialog } from "@/components/support/new-complaint-dialog"
import { PastComplaints } from "@/components/support/past-complaints"
import { PresenceBadge } from "@/components/support/presence-badge"
import { ThreadList } from "@/components/support/thread-list"
import { cn } from "@/lib/utils"
import { threadFromSearch, visiblePanes } from "@/lib/support-client"

export default function SupportPage() {
  const router = useRouter()
  const { user, loading: authLoading } = useAuth()
  const { threads, messagesByThread, unreadByThread, openThread, closeThread, sendMessage, reload, loading, error } =
    useSupportThreads(user?.id)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [newOpen, setNewOpen] = useState(false)
  const paramHandled = useRef(false)

  useEffect(() => {
    if (!authLoading && !user) router.push("/auth/login")
  }, [user, authLoading, router])

  // Opening a thread loads its messages and sends receipts only if something is unread.
  // Messages arriving while it is open are handled by the hook's Realtime handler.
  useEffect(() => {
    if (!selectedId) return
    void openThread(selectedId)
    return () => closeThread()
  }, [selectedId, openThread, closeThread])

  // Arriving from another page with ?thread=<id>: select it once, if it is the user's own.
  useEffect(() => {
    if (loading || paramHandled.current) return
    paramHandled.current = true
    const id = threadFromSearch(window.location.search, threads)
    if (id) setSelectedId(id)
  }, [loading, threads])

  if (authLoading || !user) {
    return (
      <DashboardLayout>
        <div className="flex h-screen items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin" />
        </div>
      </DashboardLayout>
    )
  }

  const selected = threads.find((t) => t.id === selectedId) ?? null
  const panes = visiblePanes(selected ? selected.id : null)

  return (
    <DashboardLayout>
      <div className="mx-auto max-w-2xl space-y-4 lg:max-w-6xl">
        <DashboardHeroBanner
          title="Support & Complaints"
          subtitle="Chat with support about your orders and payments"
          icon={MessageSquareText}
        />

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <ContactHub />
            <PresenceBadge />
          </div>
          <Button onClick={() => setNewOpen(true)} className="gap-1.5">
            <Plus className="h-4 w-4" /> New Complaint
          </Button>
        </div>

        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}

        <div className="overflow-hidden rounded-2xl border border-border bg-card lg:grid lg:h-[65vh] lg:grid-cols-[360px_1fr]">
          <div className={cn("max-h-[70vh] overflow-y-auto lg:max-h-none lg:border-r lg:border-border", !panes.list && "hidden lg:block")}>
            {loading ? (
              <div className="flex justify-center p-8">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <ThreadList threads={threads} unreadByThread={unreadByThread} selectedId={selectedId} onSelect={setSelectedId} />
            )}
          </div>
          <div className={cn("h-[70vh] lg:h-full", !panes.chat && "hidden lg:block")}>
            {selected ? (
              <ChatPane
                thread={selected}
                messages={messagesByThread[selected.id] ?? []}
                onSend={(text) => sendMessage(selected.id, text)}
                onBack={() => setSelectedId(null)}
                onNew={() => setNewOpen(true)}
              />
            ) : (
              <div className="flex h-full items-center justify-center p-8 text-sm text-muted-foreground">
                Select a conversation to read it.
              </div>
            )}
          </div>
        </div>

        <PastComplaints userId={user.id} />
      </div>
      <NewComplaintDialog
        open={newOpen}
        onOpenChange={setNewOpen}
        onCreated={async (threadId) => {
          await reload()
          setSelectedId(threadId)
        }}
      />
    </DashboardLayout>
  )
}
