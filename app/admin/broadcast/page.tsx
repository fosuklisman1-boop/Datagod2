"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import {
    Send,
    Users,
    Mail,
    MessageSquare,
    Loader2,
    CheckCircle2,
    AlertCircle,
    Search,
    X,
    History,
    ChevronLeft
} from "lucide-react"
import { supabase } from "@/lib/supabase"
import { toast } from "sonner"
import { adminUserService } from "@/lib/admin-service"

export default function BroadcastPage() {
    const router = useRouter()
    const [isAdmin, setIsAdmin] = useState(false)
    const [loading, setLoading] = useState(true)
    const [sending, setSending] = useState(false)

    // Recipients
    const [targetType, setTargetType] = useState<"roles" | "specific">("roles")
    const [selectedRoles, setSelectedRoles] = useState<string[]>([])
    const [selectedUsers, setSelectedUsers] = useState<any[]>([])
    const [searchTerm, setSearchTerm] = useState("")
    const [allUsers, setAllUsers] = useState<any[]>([])

    // Message
    const [channels, setChannels] = useState<string[]>(["email"])
    const [subject, setSubject] = useState("")
    const [message, setMessage] = useState("")

    // Progress
    const [results, setResults] = useState<any | null>(null)

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
            loadUsers()
        } catch (error) {
            console.error("Error checking admin access:", error)
            router.push("/dashboard")
        } finally {
            setLoading(false)
        }
    }

    const loadUsers = async () => {
        try {
            const data = await adminUserService.getAllUsers()
            setAllUsers(data || [])
        } catch (error) {
            console.error("Error loading users:", error)
        }
    }

    const handleToggleRole = (role: string) => {
        setSelectedRoles(prev =>
            prev.includes(role) ? prev.filter(r => r !== role) : [...prev, role]
        )
    }

    const handleAddUser = (user: any) => {
        if (!selectedUsers.find(u => u.id === user.id)) {
            setSelectedUsers([...selectedUsers, user])
            setSearchTerm("")
        }
    }

    const handleRemoveUser = (userId: string) => {
        setSelectedUsers(selectedUsers.filter(u => u.id !== userId))
    }

    const handleSend = async () => {
        if (channels.length === 0) {
            toast.error("Please select at least one channel (SMS or Email)")
            return
        }

        if (targetType === "roles" && selectedRoles.length === 0) {
            toast.error("Please select at least one role")
            return
        }

        if (targetType === "specific" && selectedUsers.length === 0) {
            toast.error("Please select at least one user")
            return
        }

        if (!message.trim()) {
            toast.error("Message content cannot be empty")
            return
        }

        if (channels.includes("email") && !subject.trim()) {
            toast.error("Email subject is required")
            return
        }

        if (!confirm("Are you sure you want to send this broadcast?")) return

        setSending(true)
        setResults(null)

        try {
            const { data: { session } } = await supabase.auth.getSession()

            const response = await fetch("/api/admin/broadcast", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${session?.access_token}`
                },
                body: JSON.stringify({
                    channels,
                    recipients: {
                        type: targetType,
                        roles: selectedRoles,
                        userIds: selectedUsers.map(u => u.id)
                    },
                    subject,
                    message
                })
            })

            const data = await response.json()

            if (!response.ok) {
                throw new Error(data.error || "Failed to send broadcast")
            }

            setResults(data.results)
            toast.success("Broadcast sent successfully!")
            setMessage("")
            setSubject("")
            setSelectedUsers([])
            setSelectedRoles([])
        } catch (error: any) {
            console.error("Broadcast error:", error)
            toast.error(error.message || "An error occurred during broadcast")
        } finally {
            setSending(false)
        }
    }

    const filteredSearch = searchTerm.trim()
        ? allUsers.filter(u =>
            u.email?.toLowerCase().includes(searchTerm.toLowerCase()) ||
            u.phoneNumber?.toLowerCase().includes(searchTerm.toLowerCase()) ||
            u.first_name?.toLowerCase().includes(searchTerm.toLowerCase())
        ).slice(0, 10)
        : []

    if (loading || !isAdmin) {
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
            <div className="max-w-4xl mx-auto space-y-6">
                <header className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                    <div>
                        <div className="flex items-center gap-3 mb-2">
                            <div className="p-2 bg-gradient-to-br from-pink-500 to-rose-600 rounded-lg text-white">
                                <Send className="w-6 h-6" />
                            </div>
                            <h1 className="text-3xl font-bold bg-gradient-to-r from-pink-600 to-rose-600 bg-clip-text text-transparent">
                                Broadcast Messaging
                            </h1>
                        </div>
                        <p className="text-gray-500">Reach your users via SMS or Email broadcasts</p>
                    </div>
                    <Button
                        variant="outline"
                        onClick={() => router.push("/admin/broadcast/history")}
                        className="border-pink-200 hover:bg-pink-50 text-pink-700 font-semibold"
                    >
                        <History className="w-4 h-4 mr-2" />
                        View History
                    </Button>
                </header>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    {/* Settings Section */}
                    <div className="space-y-6">
                        <Card className="border-emerald-100/40 bg-white/50 backdrop-blur-sm">
                            <CardHeader>
                                <CardTitle className="text-lg flex items-center gap-2">
                                    <Users className="w-5 h-5 text-emerald-600" />
                                    Recipients
                                </CardTitle>
                                <CardDescription>Who should receive this message?</CardDescription>
                            </CardHeader>
                            <CardContent className="space-y-4">
                                <div className="flex gap-2 p-1 bg-gray-100 rounded-lg">
                                    <button
                                        onClick={() => setTargetType("roles")}
                                        className={`flex-1 py-1.5 px-3 rounded-md text-sm font-medium transition-all ${targetType === "roles" ? "bg-white shadow-sm text-emerald-600" : "text-gray-500 hover:text-gray-700"}`}
                                    >
                                        By Group
                                    </button>
                                    <button
                                        onClick={() => setTargetType("specific")}
                                        className={`flex-1 py-1.5 px-3 rounded-md text-sm font-medium transition-all ${targetType === "specific" ? "bg-white shadow-sm text-emerald-600" : "text-gray-500 hover:text-gray-700"}`}
                                    >
                                        Specific Users
                                    </button>
                                </div>

                                {targetType === "roles" ? (
                                    <div className="grid grid-cols-2 gap-2">
                                        {["admin", "shop_owner", "sub_agent", "user"].map(role => (
                                            <label key={role} className={`flex items-center gap-2 p-2 border rounded-lg cursor-pointer transition-all ${selectedRoles.includes(role) ? "bg-emerald-50 border-emerald-500" : "hover:bg-gray-50"}`}>
                                                <Checkbox
                                                    checked={selectedRoles.includes(role)}
                                                    onCheckedChange={() => handleToggleRole(role)}
                                                />
                                                <span className="text-sm capitalize">{role.replace("_", " ")}s</span>
                                            </label>
                                        ))}
                                    </div>
                                ) : (
                                    <div className="space-y-3">
                                        <div className="relative">
                                            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                                            <Input
                                                placeholder="Search by email or phone..."
                                                className="pl-9"
                                                value={searchTerm}
                                                onChange={(e) => setSearchTerm(e.target.value)}
                                            />
                                            {searchTerm && filteredSearch.length > 0 && (
                                                <div className="absolute z-10 w-full mt-1 bg-white border rounded-lg shadow-xl max-h-48 overflow-y-auto">
                                                    {filteredSearch.map(user => (
                                                        <button
                                                            key={user.id}
                                                            onClick={() => handleAddUser(user)}
                                                            className="w-full text-left px-4 py-2 hover:bg-gray-50 text-sm flex justify-between items-center"
                                                        >
                                                            <span>{user.email || user.phoneNumber}</span>
                                                            <Badge variant="outline" className="text-[10px]">{user.role}</Badge>
                                                        </button>
                                                    ))}
                                                </div>
                                            )}
                                        </div>
                                        <div className="flex flex-wrap gap-2">
                                            {selectedUsers.map(user => (
                                                <Badge key={user.id} className="bg-emerald-100 text-emerald-700 hover:bg-emerald-200 border-none px-2 py-1 flex items-center gap-1">
                                                    {user.email || user.phoneNumber}
                                                    <X className="w-3 h-3 cursor-pointer" onClick={() => handleRemoveUser(user.id)} />
                                                </Badge>
                                            ))}
                                        </div>
                                    </div>
                                )}
                            </CardContent>
                        </Card>

                        <Card className="border-pink-100/40 bg-white/50 backdrop-blur-sm">
                            <CardHeader>
                                <CardTitle className="text-lg flex items-center gap-2">
                                    <MessageSquare className="w-5 h-5 text-pink-600" />
                                    Channels
                                </CardTitle>
                            </CardHeader>
                            <CardContent className="flex gap-4">
                                <label className={`flex-1 flex items-center gap-3 p-4 border rounded-xl cursor-pointer transition-all ${channels.includes("email") ? "bg-pink-50 border-pink-500" : "hover:bg-gray-50"}`}>
                                    <Checkbox checked={channels.includes("email")} onCheckedChange={(val) => setChannels(prev => val ? [...prev, "email"] : prev.filter(c => c !== "email"))} />
                                    <div className="flex flex-col">
                                        <span className="font-semibold text-pink-700">Email</span>
                                        <span className="text-xs text-gray-500">Premium HTML template</span>
                                    </div>
                                    <Mail className="ml-auto w-5 h-5 text-pink-400" />
                                </label>
                                <label className={`flex-1 flex items-center gap-3 p-4 border rounded-xl cursor-pointer transition-all ${channels.includes("sms") ? "bg-emerald-50 border-emerald-500" : "hover:bg-gray-50"}`}>
                                    <Checkbox checked={channels.includes("sms")} onCheckedChange={(val) => setChannels(prev => val ? [...prev, "sms"] : prev.filter(c => c !== "sms"))} />
                                    <div className="flex flex-col">
                                        <span className="font-semibold text-emerald-700">SMS</span>
                                        <span className="text-xs text-gray-500">Fast delivery</span>
                                    </div>
                                    <MessageSquare className="ml-auto w-5 h-5 text-emerald-400" />
                                </label>
                            </CardContent>
                        </Card>
                    </div>

                    {/* Message Content Section */}
                    <div className="space-y-6">
                        <Card className="border-gray-100 shadow-lg">
                            <CardHeader>
                                <CardTitle className="text-lg">Message Content</CardTitle>
                            </CardHeader>
                            <CardContent className="space-y-4">
                                {channels.includes("email") && (
                                    <div className="space-y-2">
                                        <Label>Email Subject</Label>
                                        <Input
                                            placeholder="Enter subject line..."
                                            value={subject}
                                            onChange={(e) => setSubject(e.target.value)}
                                        />
                                    </div>
                                )}
                                <div className="space-y-2">
                                    <Label>Message Body</Label>
                                    <Textarea
                                        placeholder="Type your message here..."
                                        className="min-h-[200px]"
                                        value={message}
                                        onChange={(e) => setMessage(e.target.value)}
                                    />
                                    <p className="text-xs text-gray-400">
                                        {channels.includes("sms") && `${message.length} characters (${Math.ceil(message.length / 160)} SMS parts)`}
                                    </p>
                                </div>

                                <Button
                                    onClick={handleSend}
                                    disabled={sending}
                                    className="w-full bg-gradient-to-r from-pink-600 to-rose-600 hover:from-pink-700 hover:to-rose-700 h-12 text-lg font-bold"
                                >
                                    {sending ? (
                                        <>
                                            <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                                            Sending Broadcast...
                                        </>
                                    ) : (
                                        <>
                                            <Send className="w-5 h-5 mr-2" />
                                            Send Now
                                        </>
                                    )}
                                </Button>
                            </CardContent>
                        </Card>

                        {results && (
                            <Card className="border-emerald-200 bg-emerald-50/50">
                                <CardHeader className="pb-2">
                                    <CardTitle className="text-sm flex items-center gap-2">
                                        <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                                        Broadcast Results
                                    </CardTitle>
                                </CardHeader>
                                <CardContent>
                                    <div className="grid grid-cols-2 gap-4 text-sm">
                                        <div className="p-3 bg-white rounded-lg border">
                                            <p className="text-gray-500 text-xs">Email Delivery</p>
                                            <p className="text-xl font-bold text-emerald-600">
                                                {results.email.sent} <span className="text-xs text-gray-400">/ {results.total}</span>
                                            </p>
                                        </div>
                                        <div className="p-3 bg-white rounded-lg border">
                                            <p className="text-gray-500 text-xs">SMS Delivery</p>
                                            <p className="text-xl font-bold text-emerald-600">
                                                {results.sms.sent} <span className="text-xs text-gray-400">/ {results.total}</span>
                                            </p>
                                        </div>
                                    </div>
                                </CardContent>
                            </Card>
                        )}
                    </div>
                </div>
            </div>
        </DashboardLayout>
    )
}
