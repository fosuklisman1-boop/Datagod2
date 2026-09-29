"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { useAuth } from "@/hooks/use-auth"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { Badge } from "@/components/ui/badge"
import { AlertCircle, Loader2, CheckCircle2, Clock, XCircle, Search, MessageSquareText } from "lucide-react"
import { toast } from "sonner"
import { complaintService } from "@/lib/database"

interface Complaint {
  id: string
  user_id: string
  title: string
  description: string
  status: string
  priority: string
  order_id?: string
  order_details?: any
  evidence?: any
  resolution_notes?: string
  created_at: string
  updated_at: string
}

const STATUS_META: Record<string, { label: string; badge: string }> = {
  pending: { label: "Pending", badge: "bg-warning/15 text-warning" },
  in_review: { label: "In Review", badge: "bg-[#1b388b]/10 text-[#1b388b]" },
  resolved: { label: "Resolved", badge: "bg-success/15 text-success" },
  rejected: { label: "Rejected", badge: "bg-destructive/15 text-destructive" },
}

const PRIORITY_META: Record<string, { label: string; badge: string }> = {
  low: { label: "Low", badge: "bg-success/10 text-success" },
  medium: { label: "Medium", badge: "bg-warning/10 text-warning" },
  high: { label: "High", badge: "bg-destructive/10 text-destructive" },
  urgent: { label: "Urgent", badge: "bg-destructive text-destructive-foreground" },
}

export default function ComplaintsPage() {
  const router = useRouter()
  const { user, loading: authLoading } = useAuth()
  const [complaints, setComplaints] = useState<Complaint[]>([])
  const [loading, setLoading] = useState(true)
  const [searchTerm, setSearchTerm] = useState("")
  const [expandedId, setExpandedId] = useState<string | null>(null)

  useEffect(() => {
    if (!authLoading && !user) {
      router.push("/auth/login")
    }
  }, [user, authLoading, router])

  useEffect(() => {
    if (user && !authLoading) {
      loadComplaints()
    }
  }, [user, authLoading])

  const loadComplaints = async () => {
    try {
      setLoading(true)
      const data = await complaintService.getComplaints(user!.id)
      setComplaints(data || [])
    } catch (error) {
      console.error("Error loading complaints:", error)
      const errorMessage = error instanceof Error ? error.message : "Failed to load complaints"
      toast.error(errorMessage)
    } finally {
      setLoading(false)
    }
  }

  const filteredComplaints = complaints.filter((c) =>
    c.title?.toLowerCase().includes(searchTerm.toLowerCase()) ||
    c.description?.toLowerCase().includes(searchTerm.toLowerCase()) ||
    c.id?.toLowerCase().includes(searchTerm.toLowerCase())
  )

  const stats = {
    total: complaints.length,
    pending: complaints.filter((c) => c.status?.toLowerCase() === "pending").length,
    resolved: complaints.filter((c) => c.status?.toLowerCase() === "resolved").length,
    rejected: complaints.filter((c) => c.status?.toLowerCase() === "rejected").length,
  }

  if (authLoading || !user) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center h-screen">
          <Loader2 className="w-8 h-8 animate-spin" />
        </div>
      </DashboardLayout>
    )
  }

  return (
    <DashboardLayout>
      <div className="max-w-2xl lg:max-w-4xl mx-auto space-y-5">
        {/* Page Header */}
        <div>
          <h1 className="text-2xl font-bold text-foreground">My Complaints</h1>
          <p className="mt-1 text-sm text-muted-foreground">Track your complaint submissions and support responses</p>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-3">
          <div className="rounded-2xl border border-border bg-card p-4">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-[#1b388b]/10 text-[#1b388b]">
              <AlertCircle className="h-4 w-4" />
            </span>
            <p className="mt-2 text-lg font-black text-foreground">{stats.total}</p>
            <p className="text-xs text-muted-foreground">Total</p>
          </div>
          <div className="rounded-2xl border border-border bg-card p-4">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-warning/10 text-warning">
              <Clock className="h-4 w-4" />
            </span>
            <p className="mt-2 text-lg font-black text-foreground">{stats.pending}</p>
            <p className="text-xs text-muted-foreground">Pending</p>
          </div>
          <div className="rounded-2xl border border-border bg-card p-4">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-success/10 text-success">
              <CheckCircle2 className="h-4 w-4" />
            </span>
            <p className="mt-2 text-lg font-black text-foreground">{stats.resolved}</p>
            <p className="text-xs text-muted-foreground">Resolved</p>
          </div>
          <div className="rounded-2xl border border-border bg-card p-4">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-destructive/10 text-destructive">
              <XCircle className="h-4 w-4" />
            </span>
            <p className="mt-2 text-lg font-black text-foreground">{stats.rejected}</p>
            <p className="text-xs text-muted-foreground">Rejected</p>
          </div>
        </div>

        {/* Search */}
        <div className="relative">
          <Search className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search by title, description, or ticket ID..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full rounded-2xl border border-border bg-card py-2.5 pl-10 pr-4 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-[#1b388b]/30"
          />
        </div>

        {/* Complaints List */}
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        ) : filteredComplaints.length === 0 ? (
          <div className="rounded-2xl border border-border bg-card p-8 text-center">
            <AlertCircle className="mx-auto mb-2 h-10 w-10 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              {complaints.length === 0 ? "No complaints filed yet." : "No complaints match your search."}
            </p>
          </div>
        ) : (
          <div className="space-y-2 lg:grid lg:grid-cols-2 lg:gap-3 lg:space-y-0 lg:items-start">
            {filteredComplaints.map((complaint) => {
              const statusMeta = STATUS_META[complaint.status?.toLowerCase()] || { label: complaint.status || "Unknown", badge: "bg-muted text-foreground" }
              const priorityMeta = PRIORITY_META[complaint.priority?.toLowerCase()] || { label: complaint.priority || "—", badge: "bg-muted text-muted-foreground" }
              const expanded = expandedId === complaint.id
              return (
                <button
                  key={complaint.id}
                  onClick={() => setExpandedId(expanded ? null : complaint.id)}
                  className="w-full rounded-2xl border border-border bg-card p-4 text-left transition hover:border-[#1b388b]/30"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-foreground">{complaint.title}</p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        #{complaint.id.slice(0, 8)} · {new Date(complaint.created_at).toLocaleDateString()}
                      </p>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1.5">
                      <Badge className={statusMeta.badge}>{statusMeta.label}</Badge>
                      <Badge className={priorityMeta.badge}>{priorityMeta.label}</Badge>
                    </div>
                  </div>

                  {expanded && (
                    <div className="mt-3 space-y-2 border-t border-border pt-3">
                      <p className="text-sm text-foreground whitespace-pre-wrap">{complaint.description}</p>
                      {complaint.resolution_notes && (
                        <div className="rounded-xl bg-muted/40 p-3">
                          <p className="flex items-center gap-1.5 text-xs font-bold text-foreground">
                            <MessageSquareText className="h-3.5 w-3.5" /> Response from support
                          </p>
                          <p className="mt-1 text-sm text-muted-foreground whitespace-pre-wrap">{complaint.resolution_notes}</p>
                        </div>
                      )}
                    </div>
                  )}
                </button>
              )
            })}
          </div>
        )}

        {/* Submit Complaint */}
        <div className="flex flex-col items-center gap-2 pt-2">
          <button
            onClick={() => router.push("/dashboard/my-orders")}
            className="rounded-2xl bg-[#1b388b] px-8 py-3 text-sm font-bold text-primary-foreground hover:bg-[#1b388b]/90"
          >
            File a New Complaint
          </button>
          <p className="text-xs text-muted-foreground">Complaints are filed against a specific order — pick one from My Orders.</p>
        </div>
      </div>
    </DashboardLayout>
  )
}
