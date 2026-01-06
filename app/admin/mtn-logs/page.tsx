"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { 
  Loader2, 
  RefreshCw, 
  CheckCircle, 
  XCircle, 
  Clock, 
  AlertTriangle,
  ArrowLeft,
  Phone,
  Send,
  ExternalLink
} from "lucide-react"
import { useAdminProtected } from "@/hooks/use-admin"
import { supabase } from "@/lib/supabase"
import { toast } from "sonner"
import Link from "next/link"

interface MTNLog {
  id: string
  shop_order_id: string
  mtn_order_id: number | null
  status: "pending" | "completed" | "failed" | "retrying" | "error"
  recipient_phone: string
  network: string
  size_gb: number
  external_status: string | null
  external_message: string | null
  retry_count: number
  last_retry_at: string | null
  created_at: string
  updated_at: string
  webhook_received_at: string | null
  api_response_payload: any
}

interface Summary {
  total: number
  pending: number
  completed: number
  failed: number
  retrying: number
}

export default function MTNFulfillmentLogsPage() {
  const router = useRouter()
  const { isAdmin, loading: adminLoading } = useAdminProtected()
  
  const [logs, setLogs] = useState<MTNLog[]>([])
  const [loading, setLoading] = useState(true)
  const [summary, setSummary] = useState<Summary>({ total: 0, pending: 0, completed: 0, failed: 0, retrying: 0 })
  const [activeTab, setActiveTab] = useState<string>("all")
  const [retrying, setRetrying] = useState<string | null>(null)

  useEffect(() => {
    if (adminLoading) return
    if (!isAdmin) return

    loadLogs()
  }, [isAdmin, adminLoading, activeTab])

  const loadLogs = async () => {
    try {
      setLoading(true)
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) {
        toast.error("Authentication required")
        return
      }

      const statusParam = activeTab !== "all" ? `&status=${activeTab}` : ""
      const response = await fetch(`/api/admin/fulfillment/mtn-logs?limit=100${statusParam}`, {
        headers: {
          Authorization: `Bearer ${session.access_token}`,
        },
      })

      if (response.ok) {
        const data = await response.json()
        setLogs(data.logs || [])
        setSummary(data.summary || { total: 0, pending: 0, completed: 0, failed: 0, retrying: 0 })
      } else {
        toast.error("Failed to load MTN logs")
      }
    } catch (error) {
      console.error("Error loading logs:", error)
      toast.error("Error loading MTN logs")
    } finally {
      setLoading(false)
    }
  }

  const handleRetry = async (logId: string, shopOrderId: string) => {
    try {
      setRetrying(logId)
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) {
        toast.error("Authentication required")
        return
      }

      const response = await fetch("/api/admin/fulfillment/manual-fulfill", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          shop_order_id: shopOrderId,
        }),
      })

      const data = await response.json()
      
      if (response.ok && data.success) {
        toast.success("Order re-submitted to MTN API")
        loadLogs() // Refresh the list
      } else {
        toast.error(data.error || data.message || "Failed to retry order")
      }
    } catch (error) {
      console.error("Error retrying order:", error)
      toast.error("Error retrying order")
    } finally {
      setRetrying(null)
    }
  }

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "completed":
        return <Badge className="bg-green-500"><CheckCircle className="w-3 h-3 mr-1" /> Completed</Badge>
      case "failed":
        return <Badge variant="destructive"><XCircle className="w-3 h-3 mr-1" /> Failed</Badge>
      case "pending":
        return <Badge variant="secondary"><Clock className="w-3 h-3 mr-1" /> Pending</Badge>
      case "retrying":
        return <Badge className="bg-yellow-500"><RefreshCw className="w-3 h-3 mr-1" /> Retrying</Badge>
      case "error":
        return <Badge variant="destructive"><AlertTriangle className="w-3 h-3 mr-1" /> Error</Badge>
      default:
        return <Badge variant="outline">{status}</Badge>
    }
  }

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleString("en-GB", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    })
  }

  if (!isAdmin || adminLoading) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center h-screen">
          <Loader2 className="h-8 w-8 animate-spin" />
        </div>
      </DashboardLayout>
    )
  }

  return (
    <DashboardLayout>
      <div className="container mx-auto p-6 max-w-7xl">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-4">
            <Link href="/admin/settings/mtn">
              <Button variant="ghost" size="sm">
                <ArrowLeft className="w-4 h-4 mr-2" />
                Back to MTN Settings
              </Button>
            </Link>
            <div>
              <h1 className="text-2xl font-bold">MTN Fulfillment Logs</h1>
              <p className="text-muted-foreground">Track MTN API orders and their status</p>
            </div>
          </div>
          <Button onClick={loadLogs} disabled={loading}>
            <RefreshCw className={`w-4 h-4 mr-2 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>

        {/* Summary Cards */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-6">
          <Card>
            <CardContent className="p-4">
              <div className="text-2xl font-bold">{summary.total}</div>
              <div className="text-sm text-muted-foreground">Total Orders</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="text-2xl font-bold text-yellow-500">{summary.pending}</div>
              <div className="text-sm text-muted-foreground">Pending</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="text-2xl font-bold text-green-500">{summary.completed}</div>
              <div className="text-sm text-muted-foreground">Completed</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="text-2xl font-bold text-red-500">{summary.failed}</div>
              <div className="text-sm text-muted-foreground">Failed</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="text-2xl font-bold text-orange-500">{summary.retrying}</div>
              <div className="text-sm text-muted-foreground">Retrying</div>
            </CardContent>
          </Card>
        </div>

        {/* Tabs */}
        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList className="mb-4">
            <TabsTrigger value="all">All ({summary.total})</TabsTrigger>
            <TabsTrigger value="pending">Pending ({summary.pending})</TabsTrigger>
            <TabsTrigger value="completed">Completed ({summary.completed})</TabsTrigger>
            <TabsTrigger value="failed">Failed ({summary.failed})</TabsTrigger>
            <TabsTrigger value="retrying">Retrying ({summary.retrying})</TabsTrigger>
          </TabsList>

          <TabsContent value={activeTab}>
            <Card>
              <CardHeader>
                <CardTitle>Fulfillment Orders</CardTitle>
                <CardDescription>
                  Orders sent to MTN API for automatic fulfillment
                </CardDescription>
              </CardHeader>
              <CardContent>
                {loading ? (
                  <div className="flex items-center justify-center py-12">
                    <Loader2 className="h-8 w-8 animate-spin" />
                  </div>
                ) : logs.length === 0 ? (
                  <div className="text-center py-12 text-muted-foreground">
                    No MTN fulfillment orders found
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Status</TableHead>
                          <TableHead>MTN Order ID</TableHead>
                          <TableHead>Phone</TableHead>
                          <TableHead>Size</TableHead>
                          <TableHead>Created</TableHead>
                          <TableHead>Message</TableHead>
                          <TableHead>Retries</TableHead>
                          <TableHead>Actions</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {logs.map((log) => (
                          <TableRow key={log.id}>
                            <TableCell>{getStatusBadge(log.status)}</TableCell>
                            <TableCell>
                              {log.mtn_order_id ? (
                                <span className="font-mono">{log.mtn_order_id}</span>
                              ) : (
                                <span className="text-muted-foreground">-</span>
                              )}
                            </TableCell>
                            <TableCell>
                              <div className="flex items-center gap-1">
                                <Phone className="w-3 h-3 text-muted-foreground" />
                                {log.recipient_phone}
                              </div>
                            </TableCell>
                            <TableCell>{log.size_gb}GB</TableCell>
                            <TableCell className="text-sm">
                              {formatDate(log.created_at)}
                            </TableCell>
                            <TableCell className="max-w-[200px] truncate">
                              {log.external_message || log.api_response_payload?.message || "-"}
                            </TableCell>
                            <TableCell>
                              {log.retry_count > 0 ? (
                                <Badge variant="outline">{log.retry_count}</Badge>
                              ) : (
                                "-"
                              )}
                            </TableCell>
                            <TableCell>
                              {(log.status === "failed" || log.status === "error") && (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => handleRetry(log.id, log.shop_order_id)}
                                  disabled={retrying === log.id}
                                >
                                  {retrying === log.id ? (
                                    <Loader2 className="w-3 h-3 animate-spin" />
                                  ) : (
                                    <>
                                      <Send className="w-3 h-3 mr-1" />
                                      Retry
                                    </>
                                  )}
                                </Button>
                              )}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </DashboardLayout>
  )
}
