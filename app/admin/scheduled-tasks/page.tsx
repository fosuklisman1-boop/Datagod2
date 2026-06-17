"use client"

import { useEffect, useState, useCallback } from "react"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { useAdminProtected } from "@/hooks/use-admin"
import { supabase } from "@/lib/supabase"
import { toast } from "sonner"
import { Calendar, RefreshCw, Trash2, Loader2, ToggleLeft, ToggleRight, Clock, CheckCircle, XCircle } from "lucide-react"

interface ScheduledTask {
  id: string
  name: string
  prompt: string
  context: "admin" | "dashboard"
  schedule_type: "once" | "hourly" | "daily" | "weekly"
  run_at_time?: string | null
  run_on_days?: number[] | null
  run_at_timestamp?: string | null
  notify_channels: string[]
  next_run_at: string
  last_run_at?: string | null
  last_result?: string | null
  last_success?: boolean | null
  is_active: boolean
  user_id?: string | null
  created_at: string
}

async function getAuthHeaders(): Promise<Record<string, string>> {
  const { data: { session } } = await supabase.auth.getSession()
  if (session?.access_token) return { Authorization: `Bearer ${session.access_token}` }
  return {}
}

function scheduleLabel(task: ScheduledTask): string {
  if (task.schedule_type === "once") {
    return task.run_at_timestamp
      ? `Once at ${new Date(task.run_at_timestamp).toLocaleString()} GMT+0`
      : "Once"
  }
  if (task.schedule_type === "hourly") return "Every hour"
  if (task.schedule_type === "daily") return `Daily at ${task.run_at_time ?? "?"} GMT+0`
  if (task.schedule_type === "weekly") {
    const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
    const days = (task.run_on_days ?? []).map(d => dayNames[d]).join(", ")
    return `Weekly (${days}) at ${task.run_at_time ?? "?"} GMT+0`
  }
  return task.schedule_type
}

function formatRelative(iso?: string | null): string {
  if (!iso) return "—"
  const d = new Date(iso)
  const now = Date.now()
  const diff = now - d.getTime()
  if (diff < 0) {
    const abs = Math.abs(diff)
    if (abs < 60_000) return "in a moment"
    if (abs < 3_600_000) return `in ${Math.floor(abs / 60_000)}m`
    if (abs < 86_400_000) return `in ${Math.floor(abs / 3_600_000)}h`
    return d.toLocaleDateString()
  }
  if (diff < 60_000) return "just now"
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return d.toLocaleDateString()
}

export default function ScheduledTasksPage() {
  const { isAdmin, loading: adminLoading } = useAdminProtected()
  const [tasks, setTasks] = useState<ScheduledTask[]>([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<"active" | "inactive">("active")
  const [expandedResult, setExpandedResult] = useState<string | null>(null)
  const [actionId, setActionId] = useState<string | null>(null)

  const loadTasks = useCallback(async () => {
    setLoading(true)
    try {
      const headers = await getAuthHeaders()
      const res = await fetch("/api/admin/scheduled-tasks", { headers })
      const data = await res.json()
      if (res.ok) setTasks(data.tasks ?? [])
      else toast.error(data.error ?? "Failed to load tasks")
    } catch {
      toast.error("Failed to load tasks")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (isAdmin && !adminLoading) loadTasks()
  }, [isAdmin, adminLoading, loadTasks])

  async function toggleTask(task: ScheduledTask) {
    setActionId(task.id)
    try {
      const headers = await getAuthHeaders()
      const res = await fetch(`/api/admin/scheduled-tasks/${task.id}`, {
        method: "PATCH",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ is_active: !task.is_active }),
      })
      if (res.ok) {
        setTasks(prev => prev.map(t => t.id === task.id ? { ...t, is_active: !t.is_active } : t))
        setTab(task.is_active ? "inactive" : "active")
        toast.success(task.is_active ? "Task deactivated" : "Task activated")
      } else {
        const data = await res.json()
        toast.error(data.error ?? "Failed to update task")
      }
    } catch {
      toast.error("Failed to update task")
    } finally {
      setActionId(null)
    }
  }

  async function deleteTask(task: ScheduledTask) {
    if (!confirm(`Delete task "${task.name}"?`)) return
    setActionId(task.id)
    try {
      const headers = await getAuthHeaders()
      const res = await fetch(`/api/admin/scheduled-tasks/${task.id}`, {
        method: "DELETE",
        headers,
      })
      if (res.ok) {
        setTasks(prev => prev.filter(t => t.id !== task.id))
        toast.success("Task deleted")
      } else {
        const data = await res.json()
        toast.error(data.error ?? "Failed to delete task")
      }
    } catch {
      toast.error("Failed to delete task")
    } finally {
      setActionId(null)
    }
  }

  if (adminLoading) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center h-64">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      </DashboardLayout>
    )
  }

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Scheduled Tasks</h1>
            <p className="text-muted-foreground text-sm mt-1">
              AI tasks created via the admin chat. Tasks run automatically and notify the owner on completion.
            </p>
          </div>
          <Button variant="outline" onClick={loadTasks} disabled={loading}>
            <RefreshCw className={`h-4 w-4 mr-2 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 border-b">
          {(["active", "inactive"] as const).map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-4 py-2 text-sm font-medium capitalize border-b-2 transition-colors ${
                tab === t
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              {t}
              <span className="ml-1.5 text-xs rounded-full bg-muted px-1.5 py-0.5">
                {tasks.filter(tk => tk.is_active === (t === "active")).length}
              </span>
            </button>
          ))}
        </div>

        {loading ? (
          <div className="flex items-center justify-center h-40">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : tasks.filter(t => t.is_active === (tab === "active")).length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-12 text-center">
              <Calendar className="h-10 w-10 text-muted-foreground mb-3" />
              <p className="font-medium">No {tab} tasks</p>
              {tab === "active" && (
                <p className="text-sm text-muted-foreground mt-1">
                  Create tasks from the admin AI chat — e.g. &quot;Schedule a daily task at 6pm GMT+0 to mark all processing MTN orders as completed&quot;
                </p>
              )}
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            {tasks.filter(t => t.is_active === (tab === "active")).map(task => (
              <Card key={task.id}>
                <CardHeader className="pb-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <CardTitle className="text-base">{task.name}</CardTitle>
                        <Badge variant={task.context === "admin" ? "default" : "secondary"} className="text-xs">
                          {task.context}
                        </Badge>
                        <Badge variant={task.is_active ? "default" : "outline"} className="text-xs">
                          {task.is_active ? "active" : "inactive"}
                        </Badge>
                      </div>
                      <CardDescription className="mt-1 text-xs flex items-center gap-2 flex-wrap">
                        <span className="flex items-center gap-1">
                          <Clock className="h-3 w-3" /> {scheduleLabel(task)}
                        </span>
                        <span>·</span>
                        <span>Next: {formatRelative(task.next_run_at)}</span>
                        {task.last_run_at && (
                          <>
                            <span>·</span>
                            <span>Last: {formatRelative(task.last_run_at)}</span>
                          </>
                        )}
                      </CardDescription>
                    </div>

                    <div className="flex items-center gap-1 shrink-0">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => toggleTask(task)}
                        disabled={actionId === task.id}
                        title={task.is_active ? "Deactivate" : "Activate"}
                      >
                        {actionId === task.id ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : task.is_active ? (
                          <ToggleRight className="h-4 w-4 text-success" />
                        ) : (
                          <ToggleLeft className="h-4 w-4 text-muted-foreground" />
                        )}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => deleteTask(task)}
                        disabled={actionId === task.id}
                        title="Delete"
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </div>
                  </div>
                </CardHeader>

                <CardContent className="pt-0 space-y-2">
                  <div className="rounded bg-muted px-3 py-2">
                    <p className="text-xs text-muted-foreground font-mono leading-relaxed">{task.prompt}</p>
                  </div>

                  {task.last_result && (
                    <div className="flex items-start gap-2">
                      {task.last_success === false ? (
                        <XCircle className="h-3.5 w-3.5 text-destructive shrink-0 mt-0.5" />
                      ) : (
                        <CheckCircle className="h-3.5 w-3.5 text-success shrink-0 mt-0.5" />
                      )}
                      <div className="flex-1 min-w-0">
                        <p className={`text-xs ${expandedResult === task.id ? "" : "line-clamp-2"} text-muted-foreground`}>
                          {task.last_result}
                        </p>
                        {task.last_result.length > 120 && (
                          <button
                            className="text-xs text-primary mt-0.5"
                            onClick={() => setExpandedResult(expandedResult === task.id ? null : task.id)}
                          >
                            {expandedResult === task.id ? "Show less" : "Show more"}
                          </button>
                        )}
                      </div>
                    </div>
                  )}

                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span>Channels: {task.notify_channels.join(", ")}</span>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </DashboardLayout>
  )
}
