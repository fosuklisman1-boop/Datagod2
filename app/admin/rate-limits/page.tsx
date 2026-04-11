"use client"

import { useEffect, useState, useCallback } from "react"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { useAdminProtected } from "@/hooks/use-admin"
import { supabase } from "@/lib/supabase"
import { toast } from "sonner"
import { Shield, RefreshCw, Trash2, Loader2, Search } from "lucide-react"

interface RateLimitBlock {
  id: string
  endpoint: string
  identifier: string
  request_limit: number
  window_seconds: number
  blocked_at: string
}

async function getAuthHeaders(): Promise<Record<string, string>> {
  const { data: { session } } = await supabase.auth.getSession()
  if (session?.access_token) return { Authorization: `Bearer ${session.access_token}` }
  return {}
}

export default function RateLimitsPage() {
  const { isAdmin, loading: adminLoading } = useAdminProtected()
  const [blocks, setBlocks] = useState<RateLimitBlock[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [resetting, setResetting] = useState<string | null>(null)
  const [endpointFilter, setEndpointFilter] = useState("")
  const [identifierFilter, setIdentifierFilter] = useState("")

  const fetchBlocks = useCallback(async () => {
    setLoading(true)
    try {
      const headers = await getAuthHeaders()
      const params = new URLSearchParams({ limit: "100" })
      if (endpointFilter) params.set("endpoint", endpointFilter)
      if (identifierFilter) params.set("identifier", identifierFilter)

      const res = await fetch(`/api/admin/rate-limits?${params}`, { headers })
      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.error || "Failed to fetch")
      }
      const data = await res.json()
      setBlocks(data.data || [])
      setTotal(data.count || 0)
    } catch (err: any) {
      toast.error(err.message || "Failed to load rate limit blocks")
    } finally {
      setLoading(false)
    }
  }, [endpointFilter, identifierFilter])

  useEffect(() => {
    if (!adminLoading && isAdmin) fetchBlocks()
  }, [isAdmin, adminLoading, fetchBlocks])

  const handleReset = async (block: RateLimitBlock) => {
    const key = `${block.endpoint}:${block.identifier}`
    setResetting(key)
    try {
      const headers = await getAuthHeaders()
      const res = await fetch("/api/admin/rate-limits/reset", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint: block.endpoint, identifier: block.identifier }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || "Reset failed")
      toast.success(`Rate limit cleared for ${block.identifier}`)
      setBlocks(prev => prev.filter(b => !(b.endpoint === block.endpoint && b.identifier === block.identifier)))
      setTotal(prev => Math.max(0, prev - 1))
    } catch (err: any) {
      toast.error(err.message || "Failed to reset rate limit")
    } finally {
      setResetting(null)
    }
  }

  if (adminLoading) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center h-64">
          <Loader2 className="w-8 h-8 animate-spin text-gray-400" />
        </div>
      </DashboardLayout>
    )
  }

  return (
    <DashboardLayout>
      <div className="space-y-6 p-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <Shield className="w-6 h-6 text-red-500" />
              Rate Limit Blocks
            </h1>
            <p className="text-sm text-gray-500 mt-1">
              Recent requests blocked by rate limiting. Reset a limit to immediately unblock a user or IP.
            </p>
          </div>
          <Button variant="outline" onClick={fetchBlocks} disabled={loading}>
            <RefreshCw className={`w-4 h-4 mr-2 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>

        {/* Filters */}
        <Card>
          <CardContent className="pt-4 pb-4">
            <div className="flex gap-3">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                <Input
                  placeholder="Filter by endpoint..."
                  className="pl-9"
                  value={endpointFilter}
                  onChange={e => setEndpointFilter(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && fetchBlocks()}
                />
              </div>
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                <Input
                  placeholder="Filter by identifier (user:ID or ip:x.x.x.x)..."
                  className="pl-9"
                  value={identifierFilter}
                  onChange={e => setIdentifierFilter(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && fetchBlocks()}
                />
              </div>
              <Button onClick={fetchBlocks} disabled={loading}>Search</Button>
            </div>
          </CardContent>
        </Card>

        {/* Stats */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <Card>
            <CardContent className="pt-4">
              <p className="text-sm text-gray-500">Total blocks logged</p>
              <p className="text-2xl font-bold">{total.toLocaleString()}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4">
              <p className="text-sm text-gray-500">Unique endpoints hit</p>
              <p className="text-2xl font-bold">{new Set(blocks.map(b => b.endpoint)).size}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4">
              <p className="text-sm text-gray-500">Unique identifiers blocked</p>
              <p className="text-2xl font-bold">{new Set(blocks.map(b => b.identifier)).size}</p>
            </CardContent>
          </Card>
        </div>

        {/* Table */}
        <Card>
          <CardHeader>
            <CardTitle>Blocked Requests</CardTitle>
            <CardDescription>
              Showing {blocks.length} of {total} records. Each row represents the most recent block event for that endpoint + identifier pair.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
              </div>
            ) : blocks.length === 0 ? (
              <div className="text-center py-12 text-gray-500">
                <Shield className="w-10 h-10 mx-auto mb-3 text-gray-300" />
                <p>No rate limit blocks found.</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left">
                      <th className="pb-3 pr-4 font-medium text-gray-600">Endpoint</th>
                      <th className="pb-3 pr-4 font-medium text-gray-600">Identifier</th>
                      <th className="pb-3 pr-4 font-medium text-gray-600">Limit</th>
                      <th className="pb-3 pr-4 font-medium text-gray-600">Blocked At</th>
                      <th className="pb-3 font-medium text-gray-600">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {blocks.map(block => {
                      const key = `${block.endpoint}:${block.identifier}`
                      const isUser = block.identifier.startsWith("user:")
                      return (
                        <tr key={block.id} className="hover:bg-gray-50">
                          <td className="py-3 pr-4">
                            <code className="text-xs bg-gray-100 px-1.5 py-0.5 rounded">
                              {block.endpoint}
                            </code>
                          </td>
                          <td className="py-3 pr-4">
                            <span className="flex items-center gap-1.5">
                              <Badge variant={isUser ? "default" : "secondary"} className="text-xs">
                                {isUser ? "user" : "ip"}
                              </Badge>
                              <span className="font-mono text-xs text-gray-700">
                                {block.identifier.replace(/^(user:|ip:)/, "")}
                              </span>
                            </span>
                          </td>
                          <td className="py-3 pr-4 text-gray-600">
                            {block.request_limit} / {block.window_seconds}s
                          </td>
                          <td className="py-3 pr-4 text-gray-500 text-xs">
                            {new Date(block.blocked_at).toLocaleString()}
                          </td>
                          <td className="py-3">
                            <Button
                              size="sm"
                              variant="destructive"
                              onClick={() => handleReset(block)}
                              disabled={resetting === key}
                            >
                              {resetting === key ? (
                                <Loader2 className="w-3 h-3 animate-spin" />
                              ) : (
                                <Trash2 className="w-3 h-3" />
                              )}
                              <span className="ml-1.5">Reset</span>
                            </Button>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  )
}
