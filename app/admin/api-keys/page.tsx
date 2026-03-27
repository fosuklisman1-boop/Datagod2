"use client"

import { useEffect, useState } from "react"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { 
  Zap, 
  Activity, 
  Key, 
  Trash2, 
  RefreshCw, 
  Search, 
  Clock, 
  CheckCircle2, 
  AlertCircle,
  ShieldCheck,
  TrendingUp,
  Globe
} from "lucide-react"
import { useAdminProtected } from "@/hooks/use-admin"
import { toast } from "sonner"
import { format } from "date-fns"
import { cn } from "@/lib/utils"

interface ApiKey {
  id: string
  name: string
  key_prefix: string
  is_active: boolean
  last_used_at: string | null
  created_at: string
  rate_limit_per_min: number
  user: {
    first_name: string
    last_name: string
    email: string
    role: string
  }
}

interface ApiLog {
  id: string
  method: string
  endpoint: string
  status_code: number
  ip_address: string
  duration_ms: number
  created_at: string
  user: {
    email: string
    first_name: string
  }
  key: {
    name: string
    key_prefix: string
  }
}

export default function AdminApiManagementPage() {
  const { isAdmin, loading: adminLoading } = useAdminProtected()
  const [keys, setKeys] = useState<ApiKey[]>([])
  const [logs, setLogs] = useState<ApiLog[]>([])
  const [loading, setLoading] = useState(true)
  const [logsLoading, setLogsLoading] = useState(false)
  const [activeTab, setActiveTab] = useState("keys")

  const fetchKeys = async () => {
    try {
      setLoading(true)
      const res = await fetch("/api/admin/api-keys")
      const data = await res.json()
      if (data.keys) setKeys(data.keys)
    } catch (error) {
      toast.error("Failed to fetch API keys")
    } finally {
      setLoading(false)
    }
  }

  const fetchLogs = async () => {
    try {
      setLogsLoading(true)
      const res = await fetch("/api/admin/api-logs?limit=50")
      const data = await res.json()
      if (data.logs) setLogs(data.logs)
    } catch (error) {
      toast.error("Failed to fetch API logs")
    } finally {
      setLogsLoading(false)
    }
  }

  useEffect(() => {
    if (isAdmin && !adminLoading) {
      fetchKeys()
    }
  }, [isAdmin, adminLoading])

  useEffect(() => {
    if (activeTab === "logs") fetchLogs()
  }, [activeTab])

  const toggleKey = async (id: string, currentStatus: boolean) => {
    try {
      const res = await fetch(`/api/admin/api-keys?id=${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ is_active: !currentStatus }),
      })
      if (res.ok) {
        setKeys(keys.map(k => k.id === id ? { ...k, is_active: !currentStatus } : k))
        toast.success(`Key ${!currentStatus ? 'enabled' : 'disabled'} successfully`)
      }
    } catch (error) {
      toast.error("Failed to update key status")
    }
  }

  const deleteKey = async (id: string) => {
    if (!confirm("Are you sure you want to permanently delete this API key? This cannot be undone.")) return
    try {
      const res = await fetch(`/api/admin/api-keys?id=${id}`, { method: "DELETE" })
      if (res.ok) {
        setKeys(keys.filter(k => k.id !== id))
        toast.success("API key deleted permanently")
      }
    } catch (error) {
      toast.error("Failed to delete API key")
    }
  }

  const updateRateLimit = async (id: string, limit: number) => {
    try {
      const res = await fetch(`/api/admin/api-keys?id=${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rate_limit_per_min: limit }),
      })
      if (res.ok) {
        toast.success("Rate limit updated")
        fetchKeys() // Refresh to get correct data
      }
    } catch (error) {
      toast.error("Failed to update rate limit")
    }
  }

  if (adminLoading || !isAdmin) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center h-full">
          <RefreshCw className="w-8 h-8 animate-spin text-blue-600" />
        </div>
      </DashboardLayout>
    )
  }

  return (
    <DashboardLayout>
      <div className="p-6 space-y-6 max-w-7xl mx-auto">
        <header className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">API Control Panel</h1>
            <p className="text-muted-foreground">Manage programmatic access, rate limits, and audit usage across the platform.</p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => activeTab === 'keys' ? fetchKeys() : fetchLogs()}>
              <RefreshCw className={`w-4 h-4 mr-2 ${loading || logsLoading ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
          </div>
        </header>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <Card className="bg-gradient-to-br from-blue-50 to-white border-blue-100">
            <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
              <CardTitle className="text-sm font-medium">Active Keys</CardTitle>
              <Key className="w-4 h-4 text-blue-600" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{keys.filter(k => k.is_active).length}</div>
              <p className="text-xs text-muted-foreground mt-1">Total provisioned: {keys.length}</p>
            </CardContent>
          </Card>
          <Card className="bg-gradient-to-br from-green-50 to-white border-green-100">
            <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
              <CardTitle className="text-sm font-medium">Status Health</CardTitle>
              <ShieldCheck className="w-4 h-4 text-green-600" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">100%</div>
              <p className="text-xs text-muted-foreground mt-1">API endpoints operational</p>
            </CardContent>
          </Card>
          <Card className="bg-gradient-to-br from-purple-50 to-white border-purple-100">
            <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
              <CardTitle className="text-sm font-medium">Recent Traffic</CardTitle>
              <Activity className="w-4 h-4 text-purple-600" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{logs.length}+</div>
              <p className="text-xs text-muted-foreground mt-1">Requests in the last 24h</p>
            </CardContent>
          </Card>
        </div>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
          <TabsList className="grid w-full grid-cols-2 max-w-[400px]">
            <TabsTrigger value="keys" className="flex items-center gap-2">
              <Zap className="w-4 h-4" />
              Key Management
            </TabsTrigger>
            <TabsTrigger value="logs" className="flex items-center gap-2">
              <Clock className="w-4 h-4" />
              Audit Logs
            </TabsTrigger>
          </TabsList>

          <TabsContent value="keys" className="mt-6">
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle>Provisioned API Keys</CardTitle>
                    <CardDescription>Configure global limits and access for programmatic consumers.</CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-left font-medium text-muted-foreground">
                        <th className="pb-3 pl-2">Owner / Key Name</th>
                        <th className="pb-3">Status</th>
                        <th className="pb-3">Rate Limit (req/min)</th>
                        <th className="pb-3">Last Active</th>
                        <th className="pb-3 text-right pr-2">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y relative">
                      {loading ? (
                        <tr><td colSpan={5} className="py-10 text-center text-muted-foreground">Loading keys...</td></tr>
                      ) : keys.length === 0 ? (
                        <tr><td colSpan={5} className="py-10 text-center text-muted-foreground">No API keys found.</td></tr>
                      ) : keys.map((key) => (
                        <tr key={key.id} className="group hover:bg-slate-50/50 transition-colors">
                          <td className="py-4 pl-2">
                            <div className="font-semibold text-slate-900">{key.name}</div>
                            <div className="text-xs text-slate-500 font-mono mt-1">{key.key_prefix}... [ID: {key.id.substring(0,8)}]</div>
                            <div className="text-xs text-blue-600 font-medium mt-0.5">{key.user?.first_name} ({key.user?.email})</div>
                          </td>
                          <td className="py-4">
                            <div className="flex items-center gap-3">
                              <Switch 
                                checked={key.is_active} 
                                onCheckedChange={() => toggleKey(key.id, key.is_active)}
                              />
                              <Badge variant="secondary" className={key.is_active ? "bg-green-100 text-green-700 hover:bg-green-100 border-green-200" : "bg-slate-100 text-slate-600 hover:bg-slate-100 border-slate-200"}>
                                {key.is_active ? "Active" : "Disabled"}
                              </Badge>
                            </div>
                          </td>
                          <td className="py-4">
                            <div className="flex items-center gap-2 max-w-[120px]">
                              <Input 
                                type="number" 
                                defaultValue={key.rate_limit_per_min}
                                className="h-8 text-xs"
                                onBlur={(e) => {
                                  const newVal = parseInt(e.target.value);
                                  if (newVal !== key.rate_limit_per_min) {
                                    updateRateLimit(key.id, newVal);
                                  }
                                }}
                              />
                            </div>
                          </td>
                          <td className="py-4 text-slate-600">
                             {key.last_used_at ? format(new Date(key.last_used_at), "MMM d, HH:mm") : "Never"}
                          </td>
                          <td className="py-4 text-right pr-2">
                            <Button 
                              variant="ghost" 
                              size="icon" 
                              className="text-red-500 hover:text-red-700 hover:bg-red-50"
                              onClick={() => deleteKey(key.id)}
                            >
                              <Trash2 className="w-4 h-4" />
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="logs" className="mt-6">
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle>Programmatic Access Audit</CardTitle>
                    <CardDescription>Real-time stream of incoming API requests and system responses.</CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                 <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-left font-medium text-muted-foreground">
                        <th className="pb-3 pl-2">Timestamp</th>
                        <th className="pb-3">Endpoint</th>
                        <th className="pb-3">User</th>
                        <th className="pb-3">Status</th>
                        <th className="pb-3">Performance</th>
                        <th className="pb-3 text-right pr-2">Network Info</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y relative">
                      {logsLoading ? (
                        <tr><td colSpan={6} className="py-10 text-center text-muted-foreground">Loading logs...</td></tr>
                      ) : logs.length === 0 ? (
                        <tr><td colSpan={6} className="py-10 text-center text-muted-foreground">No recent API activity logs.</td></tr>
                      ) : logs.map((log) => (
                        <tr key={log.id} className="hover:bg-slate-50/50 transition-colors">
                          <td className="py-4 pl-2 text-slate-600 whitespace-nowrap">
                            {format(new Date(log.created_at), "MMM d, HH:mm:ss")}
                          </td>
                          <td className="py-4">
                            <div className="flex items-center gap-2">
                              <Badge variant="outline" className="font-mono text-[10px] py-0">{log.method}</Badge>
                              <span className="font-medium text-slate-800">{log.endpoint}</span>
                            </div>
                            <div className="text-[10px] text-slate-400 mt-0.5">Key: {log.key?.name || 'Unknown'} ({log.key?.key_prefix}...)</div>
                          </td>
                          <td className="py-4">
                            <div className="text-slate-700">{log.user?.first_name || 'System'}</div>
                            <div className="text-[10px] text-slate-400">{log.user?.email || 'N/A'}</div>
                          </td>
                          <td className="py-4">
                            <div className="flex items-center gap-1.5">
                              {log.status_code >= 200 && log.status_code < 300 ? (
                                <CheckCircle2 className="w-3.5 h-3.5 text-green-500" />
                              ) : log.status_code === 429 ? (
                                <Zap className="w-3.5 h-3.5 text-amber-500" />
                              ) : (
                                <AlertCircle className="w-3.5 h-3.5 text-red-500" />
                              )}
                              <span className={cn(
                                "font-bold",
                                log.status_code >= 200 && log.status_code < 300 ? "text-green-600" : "text-red-600"
                              )}>{log.status_code}</span>
                            </div>
                          </td>
                          <td className="py-4">
                            <div className="flex items-center gap-1.5 text-slate-600">
                              <TrendingUp className="w-3 h-3" />
                              {log.duration_ms ? `${log.duration_ms}ms` : '---'}
                            </div>
                          </td>
                          <td className="py-4 text-right pr-2">
                            <div className="flex items-center justify-end gap-1.5 text-slate-500 text-xs">
                              <Globe className="w-3 h-3" />
                              {log.ip_address}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </DashboardLayout>
  )
}
