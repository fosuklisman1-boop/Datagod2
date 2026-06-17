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

            // Single, terminating call. The server resets the failed recipients
            // and sends the first chunk; the drain-broadcasts cron finishes any
            // remainder. No client-side polling loop (the old one spun forever on
            // permanently-failing messages).
            const response = await fetch("/api/admin/broadcast/retry", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${session.access_token}`
                },
                body: JSON.stringify({ broadcastId })
            })

            const result = await response.json()

            if (!response.ok) {
                toast.error(result.error || "Retry failed")
            } else if (result.retriedCount > 0) {
                toast.success(`Re-queued ${result.retriedCount} failed recipients. Remaining sends finish in the background.`)
                loadData()
            } else {
                toast.info(result.message || "No failed recipients to retry.")
            }

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
                    <Loader2 className="w-8 h-8 animate-spin text-success" />
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
                                <History className="w-5 h-5 text-muted-foreground" />
                                <h1 className="text-2xl font-bold">Messaging History</h1>
                            </div>
                            <p className="text-muted-foreground text-sm">Track your communication delivery and logs</p>
                        </div>
                    </div>
                    <Button onClick={loadData} variant="outline" size="sm">
                        Refresh Data
                    </Button>
                </header>

                <Tabs defaultValue="broadcasts" className="w-full">
                    <TabsList className="grid w-full grid-cols-3 bg-muted p-1 rounded-xl">
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
                                <Card className="p-8 text-center text-muted-foreground">No broadcasts found</Card>
                            ) : (
                                broadcasts.map(log => (
                                    <Card key={log.id} className="overflow-hidden border-border shadow-sm hover:shadow-md transition-shadow">
                                        <CardHeader className="bg-card to-white pb-3">
                                            <div className="flex justify-between items-start">
                                                <div>
                                                    <div className="flex items-center gap-2 mb-2">
                                                        <Badge variant="outline" className="bg-card px-3 py-1">{log.status}</Badge>
                                                        {((log.results?.email?.failed > 0) || (log.results?.sms?.failed > 0) || (log.results?.push?.failed > 0) || (log.results?.whatsapp?.failed > 0)) && (
                                                            <Button
                                                                variant="destructive"
                                                                size="sm"
                                                                className="h-7 text-xs font-bold px-3 shadow-sm animate-pulse"
                                                                onClick={(e) => {
                                                                    e.stopPropagation()
                                                                    handleRetry(log.id)
                                                                }}
                                                            >
                                                                Retry {(log.results?.email?.failed || 0) + (log.results?.sms?.failed || 0) + (log.results?.push?.failed || 0) + (log.results?.whatsapp?.failed || 0)} Failed
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
                                                    <Badge className="bg-success/15 text-success hover:bg-success/15 border-none">
                                                        {log.results?.total || 0} Recipients
                                                    </Badge>
                                                    {log.channels.includes("email") && <Mail className="w-4 h-4 text-pink-400" />}
                                                    {log.channels.includes("sms") && <MessageSquare className="w-4 h-4 text-success" />}
                                                </div>
                                            </div>
                                        </CardHeader>
                                        <CardContent className="pt-4">
                                            <div className="space-y-4">
                                                <div className="text-sm text-muted-foreground bg-muted/40 p-3 rounded-lg border italic">
                                                    "{log.message}"
                                                </div>
                                                <div className="grid grid-cols-2 gap-4">
                                                    <div className="p-3 bg-primary/5 rounded-lg border border-primary/20">
                                                        <p className="text-[10px] text-primary font-bold uppercase mb-1">Email Delivery</p>
                                                        <div className="flex justify-between items-end">
                                                            <span className="text-xl font-bold text-primary">{log.results?.email?.sent || 0}</span>
                                                            <div className="text-right">
                                                                <span className="text-xs text-blue-400 block">Sent Sukses</span>
                                                                {log.results?.email?.failed > 0 && (
                                                                    <div className="flex items-center justify-end gap-1 mt-1">
                                                                        <span className="text-xs text-destructive font-bold">{log.results?.email?.failed} Failed</span>
                                                                        <Button
                                                                            variant="link"
                                                                            size="sm"
                                                                            className="h-auto p-0 text-[10px] text-destructive underline"
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
                                                    <div className="p-3 bg-success/10 rounded-lg border border-border">
                                                        <p className="text-[10px] text-success font-bold uppercase mb-1">SMS Delivery</p>
                                                        <div className="flex justify-between items-end">
                                                            <span className="text-xl font-bold text-success">{log.results?.sms?.sent || 0}</span>
                                                            <div className="text-right">
                                                                <span className="text-xs text-success block">Delivered</span>
                                                                {log.results?.sms?.failed > 0 && (
                                                                    <div className="flex items-center justify-end gap-1 mt-1">
                                                                        <span className="text-xs text-destructive font-bold">{log.results?.sms?.failed} Failed</span>
                                                                        <Button
                                                                            variant="link"
                                                                            size="sm"
                                                                            className="h-auto p-0 text-[10px] text-destructive underline"
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
                                            <tr className="bg-muted/40 border-bottom">
                                                <th className="text-left p-4 font-semibold text-muted-foreground">Recipient</th>
                                                <th className="text-left p-4 font-semibold text-muted-foreground">Subject</th>
                                                <th className="text-left p-4 font-semibold text-muted-foreground">Status</th>
                                                <th className="text-left p-4 font-semibold text-muted-foreground">Sent At</th>
                                            </tr>
                                        </thead>
                                        <tbody className="divide-y">
                                            {emails.map(log => (
                                                <tr key={log.id} className="hover:bg-accent transition-colors">
                                                    <td className="p-4">
                                                        <div className="font-medium">{log.user?.first_name || 'Guest'}</div>
                                                        <div className="text-xs text-muted-foreground font-mono">{log.email}</div>
                                                    </td>
                                                    <td className="p-4 max-w-xs truncate">{log.subject}</td>
                                                    <td className="p-4">
                                                        {log.status === 'sent' ? (
                                                            <Badge className="bg-success/15 text-success">Sent</Badge>
                                                        ) : (
                                                            <Badge variant="destructive">{log.status}</Badge>
                                                        )}
                                                    </td>
                                                    <td className="p-4 text-muted-foreground whitespace-nowrap">
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
                                            <tr className="bg-muted/40 border-bottom">
                                                <th className="text-left p-4 font-semibold text-muted-foreground">Recipient</th>
                                                <th className="text-left p-4 font-semibold text-muted-foreground">Message</th>
                                                <th className="text-left p-4 font-semibold text-muted-foreground">Status</th>
                                                <th className="text-left p-4 font-semibold text-muted-foreground">Sent At</th>
                                            </tr>
                                        </thead>
                                        <tbody className="divide-y">
                                            {smsLogs.map(log => (
                                                <tr key={log.id} className="hover:bg-accent transition-colors">
                                                    <td className="p-4">
                                                        <div className="font-medium">{log.user?.first_name || 'User'}</div>
                                                        <div className="text-xs text-muted-foreground font-mono">{log.phone_number}</div>
                                                    </td>
                                                    <td className="p-4 max-w-sm truncate text-muted-foreground italic">"{log.message}"</td>
                                                    <td className="p-4">
                                                        {log.status === 'sent' || log.status === 'delivered' ? (
                                                            <Badge className="bg-success/15 text-success">Sent</Badge>
                                                        ) : (
                                                            <Badge variant="destructive">{log.status}</Badge>
                                                        )}
                                                    </td>
                                                    <td className="p-4 text-muted-foreground whitespace-nowrap">
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
