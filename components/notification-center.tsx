"use client"

import { useEffect, useState } from "react"
import { notificationService, type Notification } from "@/lib/notification-service"
import { useAuth } from "@/lib/auth-context"
import { Button } from "@/components/ui/button"
import { Bell, X, Check, CheckCircle2, Trash2, BellRing } from "lucide-react"
import Link from "next/link"
import { cn } from "@/lib/utils"
import { supabase } from "@/lib/supabase"

export function NotificationCenter() {
  const { user } = useAuth()
  const [notifications, setNotifications] = useState<Notification[]>([])
  const [unreadCount, setUnreadCount] = useState(0)
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(true)
  const [pushPermission, setPushPermission] = useState<NotificationPermission | null>(null)
  const [enablingPush, setEnablingPush] = useState(false)

  useEffect(() => {
    if (!user?.id) return
    loadNotifications()
    subscribeToNotifications()
    if (typeof window !== 'undefined' && 'Notification' in window) {
      setPushPermission(Notification.permission)
    }
  }, [user?.id])

  const handleEnablePush = async () => {
    if (!user?.id || !('serviceWorker' in navigator) || !('PushManager' in window)) return
    setEnablingPush(true)
    try {
      const permission = await Notification.requestPermission()
      setPushPermission(permission)
      if (permission !== 'granted') return

      const vapidKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY
      if (!vapidKey) return

      const registration = await navigator.serviceWorker.ready
      const existing = await registration.pushManager.getSubscription()
      if (existing) return

      const { urlBase64ToUint8Array } = await import('@/lib/vapid-utils')
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidKey),
      })
      await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscription, userId: user.id }),
      })
    } catch (err) {
      console.warn('[Push] Enable failed:', err)
    } finally {
      setEnablingPush(false)
    }
  }

  const loadNotifications = async () => {
    if (!user?.id) return
    try {
      const data = await notificationService.getAllNotifications(user.id, 20)
      setNotifications(data)

      const unread = data.filter((n) => !n.read).length
      setUnreadCount(unread)
    } catch (error) {
      console.error("Error loading notifications:", error)
    } finally {
      setLoading(false)
    }
  }

  const subscribeToNotifications = () => {
    if (!user?.id) return

    const subscription = notificationService.subscribeToNotifications(user.id, (newNotification) => {
      setNotifications((prev) => [newNotification, ...prev])
      setUnreadCount((prev) => prev + 1)
    })

    return () => {
      subscription?.unsubscribe()
    }
  }

  const handleMarkAsRead = async (notificationId: string) => {
    try {
      await notificationService.markAsRead(notificationId)
      setNotifications((prev) =>
        prev.map((n) => (n.id === notificationId ? { ...n, read: true } : n))
      )
      setUnreadCount((prev) => Math.max(0, prev - 1))
    } catch (error) {
      console.error("Error marking notification as read:", error)
    }
  }

  const handleMarkAllAsRead = async () => {
    if (!user?.id) return
    try {
      await notificationService.markAllAsRead(user.id)
      setNotifications((prev) => prev.map((n) => ({ ...n, read: true })))
      setUnreadCount(0)
    } catch (error) {
      console.error("Error marking all notifications as read:", error)
    }
  }

  const handleDelete = async (notificationId: string) => {
    try {
      await notificationService.deleteNotification(notificationId)
      setNotifications((prev) => prev.filter((n) => n.id !== notificationId))
    } catch (error) {
      console.error("Error deleting notification:", error)
    }
  }

  if (!user) return null

  return (
    <div className="relative">
      {/* Notification Bell */}
      <button
        onClick={() => setOpen(!open)}
        className="relative p-2 text-muted-foreground hover:text-foreground hover:bg-accent rounded-full transition-colors"
      >
        <Bell className="w-6 h-6" />
        {unreadCount > 0 && (
          <span className="absolute top-0 right-0 bg-red-500 text-white text-xs font-bold rounded-full h-5 w-5 flex items-center justify-center">
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </button>

      {/* Notification Panel */}
      {open && (
        <div className="absolute right-0 top-12 w-80 sm:w-96 max-h-[60vh] sm:max-h-96 bg-card rounded-lg shadow-lg border border-border z-50 flex flex-col">
          {/* Header */}
          <div className="flex items-center justify-between p-3 sm:p-4 border-b border-border">
            <h2 className="text-base sm:text-lg font-semibold text-foreground">Notifications</h2>
            <div className="flex gap-1 sm:gap-2">
              {unreadCount > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleMarkAllAsRead}
                  className="text-xs hidden sm:inline-flex"
                >
                  <CheckCircle2 className="w-4 h-4 mr-1" />
                  Mark all read
                </Button>
              )}
              <button
                onClick={() => setOpen(false)}
                title="Close notifications"
                className="p-1 hover:bg-accent rounded"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Push opt-in banner — only shown when permission hasn't been decided */}
          {pushPermission === 'default' && (
            <div className="flex items-center gap-3 px-4 py-3 bg-primary border-b border-border">
              <BellRing className="w-5 h-5 text-primary shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium text-primary">Get push notifications</p>
                <p className="text-xs text-primary">Stay updated even when the app is closed.</p>
              </div>
              <button
                onClick={handleEnablePush}
                disabled={enablingPush}
                className="shrink-0 text-xs font-semibold bg-primary hover:bg-primary text-white px-3 py-1.5 rounded-lg transition-colors disabled:opacity-60"
              >
                {enablingPush ? "Enabling…" : "Enable"}
              </button>
            </div>
          )}

          {/* Notifications List */}
          <div className="overflow-y-auto flex-1">
            {loading ? (
              <div className="flex items-center justify-center h-32 text-muted-foreground">
                Loading...
              </div>
            ) : notifications.length === 0 ? (
              <div className="flex items-center justify-center h-32 text-muted-foreground">
                No notifications yet
              </div>
            ) : (
              <div className="divide-y divide-border">
                {notifications.map((notification) => (
                  <NotificationItem
                    key={notification.id}
                    notification={notification}
                    onMarkAsRead={handleMarkAsRead}
                    onDelete={handleDelete}
                    onClose={() => setOpen(false)}
                  />
                ))}
              </div>
            )}
          </div>

          {/* View All Link */}
          {notifications.length > 0 && (
            <div className="border-t border-border p-3 sm:p-4 text-center">
              <Link
                href="/dashboard/notifications"
                className="text-xs sm:text-sm text-primary hover:text-primary font-medium"
                onClick={() => setOpen(false)}
              >
                View all notifications
              </Link>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function NotificationItem({
  notification,
  onMarkAsRead,
  onDelete,
  onClose,
}: {
  notification: Notification
  onMarkAsRead: (id: string) => void
  onDelete: (id: string) => void
  onClose: () => void
}) {
  const getTypeColor = (type: string) => {
    switch (type) {
      case "order_update":
        return "bg-primary/5 border-l-4 border-primary"
      case "complaint_resolved":
        return "bg-green-50 border-l-4 border-green-500"
      case "payment_success":
        return "bg-green-50 border-l-4 border-green-500"
      case "withdrawal_approved":
        return "bg-green-50 border-l-4 border-green-500"
      case "withdrawal_rejected":
        return "bg-red-50 border-l-4 border-red-500"
      case "balance_updated":
        return "bg-primary border-l-4 border-primary"
      default:
        return "bg-muted/40 border-l-4 border-gray-500"
    }
  }

  const getTypeIcon = (type: string) => {
    switch (type) {
      case "payment_success":
      case "withdrawal_approved":
        return <div className="w-2 h-2 bg-green-500 rounded-full" />
      case "order_update":
        return <div className="w-2 h-2 bg-primary rounded-full" />
      case "withdrawal_rejected":
        return <div className="w-2 h-2 bg-red-500 rounded-full" />
      default:
        return <div className="w-2 h-2 bg-gray-500 rounded-full" />
    }
  }

  const formatTime = (dateString: string) => {
    const date = new Date(dateString)
    const now = new Date()
    const diffMs = now.getTime() - date.getTime()
    const diffMins = Math.floor(diffMs / 60000)
    const diffHours = Math.floor(diffMins / 60)
    const diffDays = Math.floor(diffHours / 24)

    if (diffMins < 1) return "just now"
    if (diffMins < 60) return `${diffMins}m ago`
    if (diffHours < 24) return `${diffHours}h ago`
    if (diffDays < 7) return `${diffDays}d ago`

    return date.toLocaleDateString()
  }

  return (
    <div
      className={cn(
        "p-3 sm:p-4 hover:bg-accent transition-colors cursor-pointer",
        !notification.read && "bg-primary/5"
      )}
    >
      <div className="flex gap-2 sm:gap-3">
        {/* Icon */}
        <div className="mt-1 flex-shrink-0">{getTypeIcon(notification.type)}</div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-2">
            <div className="flex-1 min-w-0">
              <p className="font-semibold text-foreground text-xs sm:text-sm">{notification.title}</p>
              <p className="text-muted-foreground text-xs sm:text-sm mt-1 line-clamp-2">
                {notification.message}
              </p>
              <p className="text-xs text-muted-foreground mt-1">{formatTime(notification.created_at)}</p>
            </div>

            {/* Unread indicator */}
            {!notification.read && (
              <div className="w-2 h-2 bg-primary rounded-full mt-1 flex-shrink-0" />
            )}
          </div>

          {/* Actions */}
          <div className="flex gap-1 sm:gap-2 mt-2 flex-wrap">
            {!notification.read && (
              <button
                onClick={() => onMarkAsRead(notification.id)}
                className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 border border-border hover:border-gray-400 rounded px-1.5 py-0.5 transition-colors"
              >
                <Check className="w-3 h-3" />
                <span className="hidden sm:inline">Mark read</span>
              </button>
            )}

            {notification.action_url && (
              <Link
                href={notification.action_url}
                onClick={onClose}
                className="text-xs text-primary hover:text-primary font-medium"
              >
                View
              </Link>
            )}

            <button
              onClick={() => onDelete(notification.id)}
              title="Delete notification"
              className="text-xs text-muted-foreground hover:text-red-600 ml-auto sm:ml-0 flex items-center gap-1 border border-border hover:border-border rounded px-1.5 py-0.5 transition-colors"
            >
              <Trash2 className="w-3 h-3" />
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
