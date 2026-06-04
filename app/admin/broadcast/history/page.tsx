"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
    History,
    ChevronLeft,
    Send,
    Mail,
    MessageSquare,
    CheckCircle2,
    XCircle,
    Clock,
    Search,
    Filter,
    Eye,
    Loader2
} from "lucide-react"
import { adminMessagingService } from "@/lib/admin-service"
import { format } from "date-fns"
import { Input } from "@/components/ui/input"
import { toast } from "sonner"
import { supabase } from "@/lib/supabase"

export default function MessagingHistoryPage() {
    const router = useRouter()
    const [loading, setLoading] = useState(true)
    const [isAdmin, setIsAdmin] = useState(false)

    // Data
    const [broadcasts, setBroadcasts] = useState<any[]>([])
    const [emails, setEmails] = useState<any[]>([])
    const [smsLogs, setSmsLogs] = useState<any[]>([])

    // Search/Filters
    const [searchTerm, setSearchTerm] = useState("")

    useEffect(() => {
        checkAdminAccess()
    }, [])

    const checkAdminAccess = async () => {
        try {
            const { data: { user } } = await supabase.auth.getUser()
            const role = user?.user_metadata?.role

            if (role !== "admin") {
                const { data: profile } = await supabase
                    .from("users")
                    .select("role")
                    .eq("id", user?.id)
                    .single()

                if (profile?.role !== "admin") {
                    toast.error("Unauthorized access")
                    router.push("/dashboard")
                    return
                }
            }

            setIsAdmin(true)
            loadData()
        } catch (error) {
            console.error("Error checking admin access:", error)
            router.push("/dashboard")
        }
    }

    const loadData = async () => {
        setLoading(true)
        try {
            const [broadcastData, emailData, smsData] = await Promise.all([
                adminMessagingService.getBroadcastLogs(),
                adminMessagingService.getEmailLogs(),
                adminMessagingService.getSMSLogs()
            ])

            setBroadcasts(broadcastData || [])
            setEmails(emailData || [])
            setSmsLogs(smsData || [])
        } catch (error: any) {
            console.error("Error loading messaging history:", error)
            toast.error("Failed to load messaging history")
        } finally {
            setLoading(false)
        }
    }

    const handleRetry = async (broadcastId: string) => {
        try {
            setLoading(true)
            const { data: { session } } = await supabase.auth.getSession()

            if (!session?.access_token) {
                toast.error("Unauthorized: Please log in again")
                setLoading(false)
                return
            }

            let hasMore = true
            let totalRetried = 0

            while (hasMore) {
                const response = await fetch("/api/admin/broadcast/retry", {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "Authorization": `Bearer ${session.access_token}`
                    },
                    body: JSON.stringify({ broadcastId, limit: 20 })
                })

                const result = await response.json()

                if (!response.ok) {
                    toast.error(result.error || "Retry failed")
                    hasMore = false
                } else {
                    totalRetried += result.retriedCount
                    hasMore = result.hasMore

                    if (hasMore) {
                        toast.loading(`Processing... ${totalRetried} sent, ${result.remainingCount} remaining`, { id: 'retry-toast' })
                        // Wait a bit before next chunk
                        await new Promise(r => setTimeout(r, 500))
                    } else {
                        toast.success(`Successfully retried ${totalRetried} messages`, { id: 'retry-toast' })
                    }
                }
            }

            // Only reload if we actually did something
            if (totalRetried > 0) loadData()

        } catch (error) {
            console.error("Retry error:", error)
            toast.error("Failed to execute retry")
        } finally {
            setLoading(false)
        }
    }

    if (loading) {
        return (
            <DashboardLayout>
                <div className="flex items-center justify-center h-64">
                    <Loader2 className="w-8 h-8 animate-spin text-emerald-600" />
                </div>
            </DashboardLayout>
        )
    }

    return (
        <DashboardLayout>
            <div className="max-w-6xl mx-auto space-y-6">
                <header className="flex items-center justify-between">
                    <div className="flex items-center gap-4">
                        <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => router.push("/admin/broadcast")}
                            className="rounded-full"
                        >
                            <ChevronLeft className="w-6 h-6" />
                        </Button>
                        <div>
                            <div className="flex items-center gap-2 mb-1">
                                <History className="w-5 h-5 text-gray-500" />
                                <h1 className="text-2xl font-bold">Messaging History</h1>
                            </div>
                            <p className="text-gray-500 text-sm">Track your communication delivery and logs</p>
                        </div>
                    </div>
                    <Button onClick={loadData} variant="outline" size="sm">
                        Refresh Data
                    </Button>
                </header>

                <Tabs defaultValue="broadcasts" className="w-full">
                    <TabsList className="grid w-full grid-cols-3 bg-gray-100 p-1 rounded-xl">
                        <TabsTrigger value="broadcasts" className="rounded-lg">
                            <Send className="w-4 h-4 mr-2" />
                            Broadcasts
                        </TabsTrigger>
                        <TabsTrigger value="emails" className="rounded-lg">
                            <Mail className="w-4 h-4 mr-2" />
                            Emails
                        </TabsTrigger>
                        <TabsTrigger value="sms" className="rounded-lg">
                            <MessageSquare className="w-4 h-4 mr-2" />
                            SMS Logs
                        </TabsTrigger>
                    </TabsList>

                    {/* Broadcasts History */}
                    <TabsContent value="broadcasts" className="mt-6">
                        <div className="grid grid-cols-1 gap-4">
                            {broadcasts.length === 0 ? (
                                <Card className="p-8 text-center text-gray-500">No broadcasts found</Card>
                            ) : (
                                broadcasts.map(log => (
                                    <Card key={log.id} className="overflow-hidden border-pink-100 shadow-sm hover:shadow-md transition-shadow">
                                        <CardHeader className="bg-gradient-to-r from-pink-50 to-white pb-3">
                                            <div className="flex justify-between items-start">
                                                <div>
                                                    <div className="flex items-center gap-2 mb-2">
                                                        <Badge variant="outline" className="bg-white px-3 py-1">{log.status}</Badge>
                                                        {((log.results?.email?.failed > 0) || (log.results?.sms?.failed > 0)) && (
                                                            <Button
                                                                variant="destructive"
                                                                size="sm"
                                                                className="h-7 text-xs font-bold px-3 shadow-sm animate-pulse"
                                                                onClick={(e) => {
                                                                    e.stopPropagation()
                                                                    handleRetry(log.id)
                                                                }}
                                                            >
                                                                Retry {(log.results?.email?.failed || 0) + (log.results?.sms?.failed || 0)} Failed
                                                            </Button>
                                                        )}
                                                    </div>
                                                    <CardTitle className="text-lg">{log.subject || 'System Notification'}</CardTitle>
                                                    <CardDescription className="flex items-center gap-2 mt-1">
                                                        <Clock className="w-3 h-3" />
                                                        {format(new Date(log.created_at), "MMM d, yyyy · p")}
                                                        {log.admin && `· by ${log.admin.first_name}`}
                                                    </CardDescription>
                                                </div>
                                                <div className="flex gap-2">
                                                    <Badge className="bg-emerald-100 text-emerald-700 hover:bg-emerald-100 border-none">
                                                        {log.results?.total || 0} Recipients
                                                    </Badge>
                                                    {log.channels.includes("email") && <Mail className="w-4 h-4 text-pink-400" />}
                                                    {log.channels.includes("sms") && <MessageSquare className="w-4 h-4 text-emerald-400" />}
                                                </div>
                                            </div>
                                        </CardHeader>
                                        <CardContent className="pt-4">
                                            <div className="space-y-4">
                                                <div className="text-sm text-gray-600 bg-gray-50 p-3 rounded-lg border italic">
                                                    "{log.message}"
                                                </div>
                                                <div className="grid grid-cols-2 gap-4">
                                                    <div className="p-3 bg-blue-50/50 rounded-lg border border-blue-100">
                                                        <p className="text-[10px] text-blue-600 font-bold uppercase mb-1">Email Delivery</p>
                                                        <div className="flex justify-between items-end">
                                                            <span className="text-xl font-bold text-blue-700">{log.results?.email?.sent || 0}</span>
                                                            <div className="text-right">
                                                                <span className="text-xs text-blue-400 block">Sent Sukses</span>
                                                                {log.results?.email?.failed > 0 && (
                                                                    <div className="flex items-center justify-end gap-1 mt-1">
                                                                        <span className="text-xs text-red-500 font-bold">{log.results?.email?.failed} Failed</span>
                                                                        <Button
                                                                            variant="link"
                                                                            size="sm"
                                                                            className="h-auto p-0 text-[10px] text-red-600 underline"
                                                                            onClick={(e) => {
                                                                                e.stopPropagation()
                                                                                handleRetry(log.id)
                                                                            }}
                                                                        >
                                                                            Retry
                                                                        </Button>
                                                                    </div>
                                                                )}
                                                            </div>
                                                        </div>
                                                    </div>
                                                    <div className="p-3 bg-emerald-50/50 rounded-lg border border-emerald-100">
                                                        <p className="text-[10px] text-emerald-600 font-bold uppercase mb-1">SMS Delivery</p>
                                                        <div className="flex justify-between items-end">
                                                            <span className="text-xl font-bold text-emerald-700">{log.results?.sms?.sent || 0}</span>
                                                            <div className="text-right">
                                                                <span className="text-xs text-emerald-400 block">Delivered</span>
                                                                {log.results?.sms?.failed > 0 && (
                                                                    <div className="flex items-center justify-end gap-1 mt-1">
                                                                        <span className="text-xs text-red-500 font-bold">{log.results?.sms?.failed} Failed</span>
                                                                        <Button
                                                                            variant="link"
                                                                            size="sm"
                                                                            className="h-auto p-0 text-[10px] text-red-600 underline"
                                                                            onClick={(e) => {
                                                                                e.stopPropagation()
                                                                                handleRetry(log.id)
                                                                            }}
                                                                        >
                                                                            Retry
                                                                        </Button>
                                                                    </div>
                                                                )}
                                                            </div>
                                                        </div>
                                                    </div>
                                                </div>
                                            </div>
                                        </CardContent>
                                    </Card>
                                ))
                            )}
                        </div>
                    </TabsContent>

                    {/* Individual Email Logs */}
                    <TabsContent value="emails" className="mt-6">
                        <Card>
                            <CardContent className="p-0">
                                <div className="overflow-x-auto">
                                    <table className="w-full text-sm">
                                        <thead>
                                            <tr className="bg-gray-50 border-bottom">
                                                <th className="text-left p-4 font-semibold text-gray-600">Recipient</th>
                                                <th className="text-left p-4 font-semibold text-gray-600">Subject</th>
                                                <th className="text-left p-4 font-semibold text-gray-600">Status</th>
                                                <th className="text-left p-4 font-semibold text-gray-600">Sent At</th>
                                            </tr>
                                        </thead>
                                        <tbody className="divide-y">
                                            {emails.map(log => (
                                                <tr key={log.id} className="hover:bg-gray-50 transition-colors">
                                                    <td className="p-4">
                                                        <div className="font-medium">{log.user?.first_name || 'Guest'}</div>
                                                        <div className="text-xs text-gray-500 font-mono">{log.email}</div>
                                                    </td>
                                                    <td className="p-4 max-w-xs truncate">{log.subject}</td>
                                                    <td className="p-4">
                                                        {log.status === 'sent' ? (
                                                            <Badge className="bg-emerald-100 text-emerald-700">Sent</Badge>
                                                        ) : (
                                                            <Badge variant="destructive">{log.status}</Badge>
                                                        )}
                                                    </td>
                                                    <td className="p-4 text-gray-500 whitespace-nowrap">
                                                        {format(new Date(log.sent_at), "MMM d, p")}
                                                    </td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            </CardContent>
                        </Card>
                    </TabsContent>

                    {/* Individual SMS Logs */}
                    <TabsContent value="sms" className="mt-6">
                        <Card>
                            <CardContent className="p-0">
                                <div className="overflow-x-auto">
                                    <table className="w-full text-sm">
                                        <thead>
                                            <tr className="bg-gray-50 border-bottom">
                                                <th className="text-left p-4 font-semibold text-gray-600">Recipient</th>
                                                <th className="text-left p-4 font-semibold text-gray-600">Message</th>
                                                <th className="text-left p-4 font-semibold text-gray-600">Status</th>
                                                <th className="text-left p-4 font-semibold text-gray-600">Sent At</th>
                                            </tr>
                                        </thead>
                                        <tbody className="divide-y">
                                            {smsLogs.map(log => (
                                                <tr key={log.id} className="hover:bg-gray-50 transition-colors">
                                                    <td className="p-4">
                                                        <div className="font-medium">{log.user?.first_name || 'User'}</div>
                                                        <div className="text-xs text-gray-500 font-mono">{log.phone_number}</div>
                                                    </td>
                                                    <td className="p-4 max-w-sm truncate text-gray-600 italic">"{log.message}"</td>
                                                    <td className="p-4">
                                                        {log.status === 'sent' || log.status === 'delivered' ? (
                                                            <Badge className="bg-emerald-100 text-emerald-700">Sent</Badge>
                                                        ) : (
                                                            <Badge variant="destructive">{log.status}</Badge>
                                                        )}
                                                    </td>
                                                    <td className="p-4 text-gray-500 whitespace-nowrap">
                                                        {format(new Date(log.sent_at), "MMM d, p")}
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
