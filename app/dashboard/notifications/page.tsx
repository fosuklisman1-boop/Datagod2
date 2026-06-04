"use client"

import { useEffect, useState } from "react"
import { useAuth } from "@/lib/auth-context"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { notificationService, type Notification } from "@/lib/notification-service"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Bell, Trash2, CheckCircle2, Archive } from "lucide-react"
import Link from "next/link"
import { toast } from "sonner"

export default function NotificationsPage() {
  const { user } = useAuth()
  const [notifications, setNotifications] = useState<Notification[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<"all" | "unread">("all")

  useEffect(() => {
    if (user?.id) {
      loadNotifications()
    }
  }, [user?.id])

  const loadNotifications = async () => {
    if (!user?.id) return
    try {
      setLoading(true)
      const data = await notificationService.getAllNotifications(user.id, 200)
      setNotifications(data)
    } catch (error) {
      console.error("Error loading notifications:", error)
      const errorMessage = error instanceof Error ? error.message : "Failed to load notifications"
      toast.error(errorMessage)
    } finally {
      setLoading(false)
    }
  }

  const handleMarkAsRead = async (notificationId: string) => {
    try {
      await notificationService.markAsRead(notificationId)
      setNotifications((prev) =>
        prev.map((n) => (n.id === notificationId ? { ...n, read: true } : n))
      )
      toast.success("Marked as read")
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Failed to mark as read"
      toast.error(errorMessage)
    }
  }

  const handleMarkAllAsRead = async () => {
    if (!user?.id) return
    try {
      await notificationService.markAllAsRead(user.id)
      setNotifications((prev) => prev.map((n) => ({ ...n, read: true })))
      toast.success("All notifications marked as read")
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Failed to mark all notifications as read"
      toast.error(errorMessage)
    }
  }

  const handleDelete = async (notificationId: string) => {
    try {
      await notificationService.deleteNotification(notificationId)
      setNotifications((prev) => prev.filter((n) => n.id !== notificationId))
      toast.success("Notification deleted")
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Failed to delete notification"
      toast.error(errorMessage)
    }
  }

  const getTypeIcon = (type: string) => {
    const iconClass = "w-5 h-5"
    switch (type) {
      case "order_update":
        return "📦"
      case "complaint_resolved":
        return "✅"
      case "payment_success":
        return "💳"
      case "withdrawal_approved":
        return "💰"
      case "withdrawal_rejected":
        return "❌"
      case "balance_updated":
        return "💵"
      default:
        return "🔔"
    }
  }

  const getTypeColor = (type: string) => {
    switch (type) {
      case "order_update":
        return "bg-blue-50 text-blue-700 border-blue-200"
      case "complaint_resolved":
        return "bg-green-50 text-green-700 border-green-200"
      case "payment_success":
        return "bg-green-50 text-green-700 border-green-200"
      case "withdrawal_approved":
        return "bg-green-50 text-green-700 border-green-200"
      case "withdrawal_rejected":
        return "bg-red-50 text-red-700 border-red-200"
      case "balance_updated":
        return "bg-purple-50 text-purple-700 border-purple-200"
      default:
        return "bg-gray-50 text-gray-700 border-gray-200"
    }
  }

  const formatDate = (dateString: string) => {
    const date = new Date(dateString)
    return date.toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    })
  }

  const filteredNotifications = notifications.filter((n) => {
    if (filter === "unread") return !n.read
    return true
  })

  const unreadCount = notifications.filter((n) => !n.read).length

  return (
    <DashboardLayout>
      <div className="space-y-6">
        {/* Page Header */}
        <div>
          <h1 className="text-3xl font-bold text-gray-900 flex items-center gap-2">
            <Bell className="w-8 h-8 text-blue-600" />
            Notifications
          </h1>
          <p className="text-gray-600 mt-1">Manage your notifications and stay updated</p>
        </div>

        {/* Stats Cards */}
        <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-3">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium text-gray-700">Total Notifications</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-gray-900">{notifications.length}</div>
              <p className="text-xs text-gray-500 mt-1">All time</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium text-gray-700">Unread</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-red-600">{unreadCount}</div>
              <p className="text-xs text-gray-500 mt-1">Need attention</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium text-gray-700">Read</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-green-600">
                {notifications.length - unreadCount}
              </div>
              <p className="text-xs text-gray-500 mt-1">Viewed</p>
            </CardContent>
          </Card>
        </div>

        {/* Controls */}
        <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center justify-between">
          <div className="flex gap-2">
            <Button
              variant={filter === "all" ? "default" : "outline"}
              size="sm"
              onClick={() => setFilter("all")}
            >
              All ({notifications.length})
            </Button>
            <Button
              variant={filter === "unread" ? "default" : "outline"}
              size="sm"
              onClick={() => setFilter("unread")}
            >
              Unread ({unreadCount})
            </Button>
          </div>

          {unreadCount > 0 && (
            <Button onClick={handleMarkAllAsRead} size="sm" variant="outline">
              <CheckCircle2 className="w-4 h-4 mr-2" />
              Mark all read
            </Button>
          )}
        </div>

        {/* Notifications List */}
        {loading ? (
          <Card>
            <CardContent className="pt-6 text-center text-gray-500">
              Loading notifications...
            </CardContent>
          </Card>
        ) : filteredNotifications.length === 0 ? (
          <Card>
            <CardContent className="pt-12 pb-12 text-center">
              <div className="flex flex-col items-center gap-3">
                <Bell className="w-12 h-12 text-gray-300" />
                <h3 className="font-semibold text-gray-700">No notifications</h3>
                <p className="text-gray-500 text-sm">
                  {filter === "unread"
                    ? "You're all caught up! All notifications have been read."
                    : "No notifications yet. Check back later."}
                </p>
              </div>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            {filteredNotifications.map((notification) => (
              <Card
                key={notification.id}
                className={`overflow-hidden transition-all hover:shadow-md ${
                  !notification.read ? "border-blue-300 bg-blue-50" : ""
                }`}
              >
                <CardContent className="p-4">
                  <div className="flex gap-4">
                    {/* Icon */}
                    <div className="text-3xl flex-shrink-0">
                      {getTypeIcon(notification.type)}
                    </div>

                    {/* Content */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex-1">
                          <div className="flex items-center gap-2">
                            <h3 className="font-semibold text-gray-900">
                              {notification.title}
                            </h3>
                            <span
                              className={`px-2 py-0.5 rounded-full text-xs font-medium border ${getTypeColor(
                                notification.type
                              )}`}
                            >
                              {notification.type.replace(/_/g, " ")}
                            </span>
                            {!notification.read && (
                              <span className="w-2 h-2 bg-blue-600 rounded-full" />
                            )}
                          </div>
                          <p className="text-gray-600 text-sm mt-1">{notification.message}</p>
                          <p className="text-xs text-gray-400 mt-2">
                            {formatDate(notification.created_at)}
                          </p>
                        </div>
                      </div>

                      {/* Actions */}
                      <div className="flex gap-2 mt-3 flex-wrap">
                        {!notification.read && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => handleMarkAsRead(notification.id)}
                            className="text-xs"
                          >
                            Mark read
                          </Button>
                        )}

                        {notification.action_url && (
                          <Link href={notification.action_url}>
                            <Button size="sm" variant="default" className="text-xs">
                              View Details
                            </Button>
                          </Link>
                        )}

                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => handleDelete(notification.id)}
                          className="text-xs text-red-600 hover:text-red-700 hover:bg-red-50"
                        >
                          <Trash2 className="w-3 h-3 mr-1" />
                          Delete
                        </Button>
                      </div>
                    </div>
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
