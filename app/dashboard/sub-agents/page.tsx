"use client"

import { useEffect, useState } from "react"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Users,
  Plus,
  Copy,
  Loader2,
  Store,
  TrendingUp,
  Clock,
  CheckCircle,
  XCircle,
  Trash2,
  Share2,
  UserMinus,
  ChevronLeft,
  ChevronRight,
} from "lucide-react"
import { toast } from "sonner"
import { supabase } from "@/lib/supabase"

interface SubAgent {
  id: string
  shop_name: string
  shop_slug: string
  is_active: boolean
  created_at: string
  tier_level: number
  total_orders: number
  total_sales: number
  your_earnings: number
}

interface Invite {
  id: string
  invite_code: string
  email: string | null
  status: string
  created_at: string
  expires_at: string
}

interface SubAgentRequest {
  id: string
  requester_name: string
  requester_phone: string
  requester_email: string | null
  message: string | null
  status: "pending" | "approved" | "rejected"
  created_at: string
}

interface ProfitRecord {
  id: string
  sub_agent_shop_name: string
  reference_code: string
  network: string
  volume_gb: string | number
  total_price: number
  profit_amount: number
  created_at: string
}

export default function SubAgentsPage() {
  const [loading, setLoading] = useState(true)
  const [subAgents, setSubAgents] = useState<SubAgent[]>([])
  const [invites, setInvites] = useState<Invite[]>([])
  const [requests, setRequests] = useState<SubAgentRequest[]>([])
  const [reviewingId, setReviewingId] = useState<string | null>(null)
  const [shopId, setShopId] = useState<string | null>(null)
  const [stats, setStats] = useState({
    totalSubAgents: 0,
    totalEarningsFromSubAgents: 0,
    activeSubAgents: 0
  })

  const [activeTab, setActiveTab] = useState<"agents" | "profits">("agents")

  // Remove sub-agent
  const [pendingRemove, setPendingRemove] = useState<SubAgent | null>(null)
  const [removingId, setRemovingId] = useState<string | null>(null)

  // Profit history
  const [profitRecords, setProfitRecords] = useState<ProfitRecord[]>([])
  const [profitLoading, setProfitLoading] = useState(false)
  const [profitLoaded, setProfitLoaded] = useState(false)
  const [profitPage, setProfitPage] = useState(1)
  const [profitTotalPages, setProfitTotalPages] = useState(1)
  const [profitTotalCount, setProfitTotalCount] = useState(0)

  // Create invite modal
  const [showInviteModal, setShowInviteModal] = useState(false)
  const [invitePhone, setInvitePhone] = useState("")
  const [inviteEmail, setInviteEmail] = useState("")
  const [creatingInvite, setCreatingInvite] = useState(false)
  const [newInviteUrl, setNewInviteUrl] = useState<string | null>(null)

  useEffect(() => {
    loadData()
  }, [])

  useEffect(() => {
    if (activeTab === "profits" && !profitLoaded) {
      loadProfitHistory(1)
    }
  }, [activeTab, profitLoaded])

  const loadData = async () => {
    try {
      setLoading(true)
      const { data: { session } } = await supabase.auth.getSession()

      if (!session?.access_token) {
        toast.error("Please log in")
        return
      }

      // Get user's shop
      const { data: shop, error: shopError } = await supabase
        .from("user_shops")
        .select("id")
        .eq("user_id", session.user.id)
        .single()

      if (shopError || !shop) {
        toast.error("Shop not found")
        return
      }

      setShopId(shop.id)

      // Fetch sub-agent stats via API (uses service role to bypass RLS)
      const statsResponse = await fetch("/api/shop/sub-agent-stats", {
        headers: { Authorization: `Bearer ${session.access_token}` }
      })

      if (statsResponse.ok) {
        const data = await statsResponse.json()
        console.log("[SUB-AGENTS] API response:", data)

        setSubAgents(data.subAgents || [])
        setStats(data.stats || {
          totalSubAgents: 0,
          activeSubAgents: 0,
          totalEarningsFromSubAgents: 0
        })
      } else {
        console.error("[SUB-AGENTS] Failed to fetch stats:", await statsResponse.text())
        toast.error("Failed to load sub-agent data")
      }

      // Get invites
      const response = await fetch("/api/shop/invites", {
        headers: { Authorization: `Bearer ${session.access_token}` }
      })

      if (response.ok) {
        const data = await response.json()
        setInvites(data.invites || [])
      }

      // Get sub-agent requests (customer-submitted, awaiting owner review)
      const reqResponse = await fetch("/api/shop/sub-agent-requests", {
        headers: { Authorization: `Bearer ${session.access_token}` }
      })
      if (reqResponse.ok) {
        const data = await reqResponse.json()
        setRequests(data.requests || [])
      }
    } catch (error) {
      console.error("Error loading data:", error)
      toast.error("Failed to load data")
    } finally {
      setLoading(false)
    }
  }

  const loadProfitHistory = async (page: number) => {
    setProfitLoading(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) return
      const res = await fetch(`/api/shop/sub-agent-profits?page=${page}&limit=20`, {
        headers: { Authorization: `Bearer ${session.access_token}` }
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || "Failed to load profit history")
      setProfitRecords(data.records || [])
      setProfitPage(data.pagination?.page || 1)
      setProfitTotalPages(data.pagination?.totalPages || 1)
      setProfitTotalCount(data.pagination?.totalCount || 0)
      setProfitLoaded(true)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to load profit history")
    } finally {
      setProfitLoading(false)
    }
  }

  const removeSubAgent = async (agent: SubAgent) => {
    setRemovingId(agent.id)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) return
      const res = await fetch(`/api/shop/sub-agents/${agent.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${session.access_token}` }
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || "Failed to remove sub-agent")

      toast.success(`${agent.shop_name} removed from your network`)
      setSubAgents((prev) => prev.filter((a) => a.id !== agent.id))
      setStats((prev) => ({ ...prev, totalSubAgents: Math.max(0, prev.totalSubAgents - 1), activeSubAgents: agent.is_active ? Math.max(0, prev.activeSubAgents - 1) : prev.activeSubAgents }))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to remove sub-agent")
    } finally {
      setRemovingId(null)
      setPendingRemove(null)
    }
  }

  const reviewRequest = async (id: string, action: "approve" | "reject") => {
    try {
      setReviewingId(id)
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) return

      const response = await fetch(`/api/shop/sub-agent-requests/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ action })
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || "Failed to review request")

      toast.success(action === "approve" ? "Approved — invite sent to the requester." : "Request declined.")
      loadData()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to review request")
    } finally {
      setReviewingId(null)
    }
  }

  const createInvite = async () => {
    try {
      setCreatingInvite(true)
      const { data: { session } } = await supabase.auth.getSession()

      if (!session?.access_token) {
        toast.error("Please log in")
        return
      }

      const response = await fetch("/api/shop/invites", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`
        },
        body: JSON.stringify({
          phone: invitePhone || null,
          email: inviteEmail || null
        })
      })

      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.error || "Failed to create invite")
      }

      setNewInviteUrl(data.invite.invite_url)
      toast.success("Invite created!")

      // Refresh invites list
      loadData()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to create invite")
    } finally {
      setCreatingInvite(false)
    }
  }

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text)
    toast.success("Copied to clipboard!")
  }

  const deleteInvite = async (inviteId: string) => {
    try {
      const { data: { session } } = await supabase.auth.getSession()

      if (!session?.access_token) return

      const response = await fetch(`/api/shop/invites?id=${inviteId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${session.access_token}` }
      })

      if (response.ok) {
        toast.success("Invite deleted")
        setInvites((prev: Invite[]) => prev.filter((i: Invite) => i.id !== inviteId))
      }
    } catch (error) {
      toast.error("Failed to delete invite")
    }
  }

  const getInviteUrl = (code: string) => {
    const baseUrl = typeof window !== "undefined" ? window.location.origin : ""
    return `${baseUrl}/join/${code}`
  }

  if (loading) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center h-screen">
          <Loader2 className="w-8 h-8 animate-spin text-[#1b388b]" />
        </div>
      </DashboardLayout>
    )
  }

  return (
    <DashboardLayout>
      <div className="mx-auto max-w-2xl lg:max-w-4xl space-y-5">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-bold text-foreground">
              <Users className="h-5 w-5 text-[#1b388b]" /> Sub-Agents
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">Manage your reseller network</p>
          </div>
          <Button
            onClick={() => {
              setShowInviteModal(true);
              setNewInviteUrl(null);
              setInvitePhone("");
            }}
            className="w-full sm:w-auto bg-[#1b388b] hover:bg-[#1b388b]/90 text-white"
          >
            <Plus className="w-4 h-4 mr-2" />
            Invite Sub-Agent
          </Button>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="rounded-2xl border border-border bg-card p-4">
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><Users className="h-3.5 w-3.5" /> Total Sub-Agents</p>
            <p className="mt-1 text-xl font-black text-foreground">{stats.totalSubAgents}</p>
            <p className="text-xs text-muted-foreground">{stats.activeSubAgents} active</p>
          </div>
          <div className="rounded-2xl border border-border bg-card p-4">
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><TrendingUp className="h-3.5 w-3.5" /> Your Earnings</p>
            <p className="mt-1 text-xl font-black text-success">GHS {(stats.totalEarningsFromSubAgents || 0).toFixed(2)}</p>
            <p className="text-xs text-muted-foreground">From their sales</p>
          </div>
          <div className="rounded-2xl border border-border bg-card p-4">
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><Clock className="h-3.5 w-3.5" /> Pending Invites</p>
            <p className="mt-1 text-xl font-black text-foreground">{invites.filter(i => i.status === "pending").length}</p>
            <p className="text-xs text-muted-foreground">Awaiting signup</p>
          </div>
        </div>

        {/* Tabs */}
        <div className="inline-flex w-full rounded-2xl bg-muted p-1">
          <button
            onClick={() => setActiveTab("agents")}
            className={`flex flex-1 items-center justify-center gap-2 rounded-xl py-2.5 text-sm font-bold transition ${activeTab === "agents" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground"}`}
          >
            <Users className="h-4 w-4" /> Sub-Agents
          </button>
          <button
            onClick={() => setActiveTab("profits")}
            className={`flex flex-1 items-center justify-center gap-2 rounded-xl py-2.5 text-sm font-bold transition ${activeTab === "profits" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground"}`}
          >
            <TrendingUp className="h-4 w-4" /> Profit History
          </button>
        </div>

        {activeTab === "agents" && (
          <div className="space-y-5">
            {/* Pending Requests — customer-submitted from the storefront's
                "Become a Sub-Agent" card, awaiting owner approval. */}
            {requests.filter((r) => r.status === "pending").length > 0 && (
              <div className="space-y-3 rounded-2xl border border-border bg-card p-4 sm:p-5">
                <div>
                  <p className="flex items-center gap-2 text-sm font-bold text-foreground"><Clock className="h-4 w-4 text-[#1b388b]" /> Pending Requests</p>
                  <p className="text-xs text-muted-foreground">People who asked to become a sub-agent from your storefront</p>
                </div>
                {requests.filter((r) => r.status === "pending").map((r) => (
                  <div key={r.id} className="rounded-2xl border border-border p-4">
                    <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
                      <div>
                        <p className="font-semibold text-foreground">{r.requester_name}</p>
                        <p className="text-sm text-muted-foreground">{r.requester_phone}{r.requester_email ? ` · ${r.requester_email}` : ""}</p>
                        {r.message && <p className="mt-1 text-sm text-foreground">&quot;{r.message}&quot;</p>}
                        <p className="text-xs text-muted-foreground mt-1">{new Date(r.created_at).toLocaleDateString()}</p>
                      </div>
                      <div className="flex gap-2 shrink-0">
                        <Button
                          size="sm"
                          onClick={() => reviewRequest(r.id, "approve")}
                          disabled={reviewingId === r.id}
                          className="bg-success hover:bg-success/90 text-white"
                        >
                          {reviewingId === r.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle className="w-4 h-4 mr-1" />}
                          Approve
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => reviewRequest(r.id, "reject")}
                          disabled={reviewingId === r.id}
                        >
                          <XCircle className="w-4 h-4 mr-1" />
                          Decline
                        </Button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Sub-Agents List */}
            <div className="rounded-2xl border border-border bg-card p-4 sm:p-5">
              <div>
                <p className="flex items-center gap-2 text-sm font-bold text-foreground"><Users className="h-4 w-4 text-[#1b388b]" /> Your Sub-Agents</p>
                <p className="text-xs text-muted-foreground">Resellers selling under your shop</p>
              </div>
              {subAgents.length === 0 ? (
                <div className="mt-4 flex items-start gap-2 rounded-2xl border border-[#1b388b]/20 bg-[#1b388b]/5 p-4 text-sm text-foreground">
                  <Store className="mt-0.5 h-4 w-4 shrink-0 text-[#1b388b]" />
                  <p>No sub-agents yet. Click &quot;Invite Sub-Agent&quot; to add resellers to your network.</p>
                </div>
              ) : (
                <div className="mt-3 space-y-2">
                  {subAgents.map((agent) => (
                    <div key={agent.id} className="rounded-2xl border border-border p-4">
                      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                        <div>
                          <div className="flex items-center gap-2">
                            <h3 className="font-semibold text-foreground">{agent.shop_name}</h3>
                            <Badge className={agent.is_active ? "bg-success/15 text-success" : "bg-muted text-muted-foreground"}>
                              {agent.is_active ? "Active" : "Inactive"}
                            </Badge>
                          </div>
                          <p className="text-sm text-muted-foreground">
                            /shop/{agent.shop_slug} • Joined {new Date(agent.created_at).toLocaleDateString()}
                          </p>
                        </div>
                        <div className="flex items-center gap-4 text-sm">
                          <div className="text-center">
                            <div className="font-semibold text-foreground">{agent.total_orders}</div>
                            <div className="text-muted-foreground">Orders</div>
                          </div>
                          <div className="text-center">
                            <div className="font-semibold text-foreground">GHS {(agent.total_sales || 0).toFixed(2)}</div>
                            <div className="text-muted-foreground">Sales</div>
                          </div>
                          <div className="text-center">
                            <div className="font-semibold text-success">GHS {(agent.your_earnings || 0).toFixed(2)}</div>
                            <div className="text-muted-foreground">Your Earnings</div>
                          </div>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setPendingRemove(agent)}
                            disabled={removingId === agent.id}
                            className="shrink-0 border-destructive/30 text-destructive hover:bg-destructive/10"
                          >
                            {removingId === agent.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <UserMinus className="w-4 h-4" />}
                          </Button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Pending Invites */}
            {invites.filter(i => i.status === "pending").length > 0 && (
              <div className="space-y-3 rounded-2xl border border-border bg-card p-4 sm:p-5">
                <div>
                  <p className="flex items-center gap-2 text-sm font-bold text-foreground"><Clock className="h-4 w-4 text-[#1b388b]" /> Pending Invites</p>
                  <p className="text-xs text-muted-foreground">Invite links waiting to be used</p>
                </div>
                {invites
                  .filter(i => i.status === "pending")
                  .map((invite) => (
                    <div key={invite.id} className="flex items-center justify-between rounded-2xl border border-border p-3">
                      <div>
                        <code className="text-sm bg-muted px-2 py-1 rounded">
                          {invite.invite_code}
                        </code>
                        {invite.email && (
                          <span className="text-sm text-muted-foreground ml-2">({invite.email})</span>
                        )}
                        <p className="text-xs text-muted-foreground mt-1">
                          Expires: {new Date(invite.expires_at).toLocaleDateString()}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => copyToClipboard(getInviteUrl(invite.invite_code))}
                        >
                          <Copy className="w-4 h-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => deleteInvite(invite.id)}
                        >
                          <Trash2 className="w-4 h-4 text-destructive" />
                        </Button>
                      </div>
                    </div>
                  ))}
              </div>
            )}
          </div>
        )}

        {activeTab === "profits" && (
          <div className="space-y-3">
            <div className="rounded-2xl border border-border bg-card p-4 sm:p-5">
              <div>
                <p className="flex items-center gap-2 text-sm font-bold text-foreground"><TrendingUp className="h-4 w-4 text-[#1b388b]" /> Profit History</p>
                <p className="text-xs text-muted-foreground">The wholesale margin you earned from each completed sub-agent order</p>
              </div>

              {profitLoading ? (
                <div className="mt-6 flex justify-center py-8">
                  <Loader2 className="h-6 w-6 animate-spin text-[#1b388b]" />
                </div>
              ) : profitRecords.length === 0 ? (
                <p className="mt-4 py-8 text-center text-sm text-muted-foreground">No sub-agent profit yet. It shows up here as soon as a sub-agent's order completes.</p>
              ) : (
                <>
                  {/* Mobile: stacked cards */}
                  <div className="mt-3 space-y-2 lg:hidden">
                    {profitRecords.map((r) => (
                      <div key={r.id} className="rounded-2xl border border-border bg-muted/30 p-3">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="truncate text-sm font-semibold text-foreground">{r.sub_agent_shop_name}</p>
                            <p className="text-xs text-muted-foreground">{r.network} {r.volume_gb}GB · {new Date(r.created_at).toLocaleDateString()}</p>
                          </div>
                          <p className="shrink-0 text-sm font-bold text-success">+GH₵{r.profit_amount.toFixed(2)}</p>
                        </div>
                        <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
                          <span>{r.reference_code}</span>
                          <span>Order total GH₵{r.total_price.toFixed(2)}</span>
                        </div>
                      </div>
                    ))}
                  </div>

                  {/* Desktop: table */}
                  <div className="mt-3 hidden overflow-hidden rounded-2xl border border-border lg:block">
                    <table className="w-full text-sm">
                      <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
                        <tr>
                          <th className="px-4 py-3 text-left font-semibold">Date</th>
                          <th className="px-4 py-3 text-left font-semibold">Sub-Agent</th>
                          <th className="px-4 py-3 text-left font-semibold">Reference</th>
                          <th className="px-4 py-3 text-left font-semibold">Package</th>
                          <th className="px-4 py-3 text-left font-semibold">Order Total</th>
                          <th className="px-4 py-3 text-left font-semibold">Your Profit</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {profitRecords.map((r) => (
                          <tr key={r.id}>
                            <td className="px-4 py-3 text-muted-foreground">{new Date(r.created_at).toLocaleDateString()}</td>
                            <td className="px-4 py-3 font-medium text-foreground">{r.sub_agent_shop_name}</td>
                            <td className="px-4 py-3 font-mono text-xs text-muted-foreground">{r.reference_code}</td>
                            <td className="px-4 py-3 text-muted-foreground">{r.network} {r.volume_gb}GB</td>
                            <td className="px-4 py-3 text-foreground">GH₵{r.total_price.toFixed(2)}</td>
                            <td className="px-4 py-3 font-semibold text-success">+GH₵{r.profit_amount.toFixed(2)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </div>

            {profitTotalPages > 1 && (
              <div className="flex items-center justify-between">
                <p className="text-xs text-muted-foreground">{profitTotalCount} record{profitTotalCount === 1 ? "" : "s"}</p>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => loadProfitHistory(profitPage - 1)}
                    disabled={profitPage <= 1 || profitLoading}
                    className="flex h-8 w-8 items-center justify-center rounded-full border border-border disabled:opacity-40"
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </button>
                  <span className="text-xs font-semibold text-foreground">{profitPage} / {profitTotalPages}</span>
                  <button
                    onClick={() => loadProfitHistory(profitPage + 1)}
                    disabled={profitPage >= profitTotalPages || profitLoading}
                    className="flex h-8 w-8 items-center justify-center rounded-full border border-border disabled:opacity-40"
                  >
                    <ChevronRight className="h-4 w-4" />
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Create Invite Modal */}
        <Dialog open={showInviteModal} onOpenChange={setShowInviteModal}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Invite Sub-Agent</DialogTitle>
              <DialogDescription>
                Create an invite link to add a new reseller to your network
              </DialogDescription>
            </DialogHeader>

            {newInviteUrl ? (
              <div className="space-y-4">
                <div className="flex items-start gap-2 rounded-2xl border border-success/30 bg-success/10 p-3 text-sm text-foreground">
                  <CheckCircle className="mt-0.5 h-4 w-4 shrink-0 text-success" />
                  <p>Invite created! Share this link with your sub-agent.</p>
                </div>

                <div className="flex items-center gap-2">
                  <Input value={newInviteUrl} readOnly className="text-sm" />
                  <Button onClick={() => copyToClipboard(newInviteUrl)}>
                    <Copy className="w-4 h-4" />
                  </Button>
                </div>

                <DialogFooter>
                  <Button variant="outline" onClick={() => setShowInviteModal(false)}>
                    Done
                  </Button>
                </DialogFooter>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="invitePhone">Phone Number (optional)</Label>
                  <Input
                    id="invitePhone"
                    type="tel"
                    placeholder="0241234567"
                    value={invitePhone}
                    onChange={(e) => setInvitePhone(e.target.value)}
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="inviteEmail">Email Address (optional)</Label>
                  <Input
                    id="inviteEmail"
                    type="email"
                    placeholder="user@example.com"
                    value={inviteEmail}
                    onChange={(e) => setInviteEmail(e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    We&apos;ll send the invite link via SMS or Email if provided.
                  </p>
                </div>

                <div className="flex items-start gap-2 rounded-2xl border border-[#1b388b]/20 bg-[#1b388b]/5 p-3 text-sm text-foreground">
                  <TrendingUp className="mt-0.5 h-4 w-4 shrink-0 text-[#1b388b]" />
                  <p>Sub-agents will buy data at your selling prices (their wholesale cost). You earn profit on every sale they make!</p>
                </div>

                <DialogFooter>
                  <Button variant="outline" onClick={() => setShowInviteModal(false)}>
                    Cancel
                  </Button>
                  <Button onClick={createInvite} disabled={creatingInvite} className="bg-[#1b388b] hover:bg-[#1b388b]/90 text-white">
                    {creatingInvite ? (
                      <>
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        Creating...
                      </>
                    ) : (
                      <>
                        <Share2 className="w-4 h-4 mr-2" />
                        Send Invite
                      </>
                    )}
                  </Button>
                </DialogFooter>
              </div>
            )}
          </DialogContent>
        </Dialog>

        {/* Remove sub-agent confirm */}
        <AlertDialog open={pendingRemove !== null} onOpenChange={(open) => !open && setPendingRemove(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Remove {pendingRemove?.shop_name} from your network?</AlertDialogTitle>
              <AlertDialogDescription>
                They&apos;ll keep their own shop, but will no longer be your sub-agent — you won&apos;t earn wholesale margin on their future sales, and they won&apos;t appear in this list. This doesn&apos;t affect their shop&apos;s active status. This can&apos;t be undone from here; they&apos;d need a new invite to rejoin.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                disabled={removingId !== null}
                className="bg-destructive text-white hover:bg-destructive/90"
                onClick={() => { if (pendingRemove) void removeSubAgent(pendingRemove) }}
              >
                Remove
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </DashboardLayout>
  )
}
