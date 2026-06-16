"use client"

import { useCallback, useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react"
import { api } from "../_lib/api"
import { calculateSegments } from "@/lib/sms/segments"
import { personalize, hasMergeTokens } from "@/lib/sms/personalize"
import { adminMessagingService } from "@/lib/admin-service"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Checkbox } from "@/components/ui/checkbox"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { toast } from "sonner"
import { Loader2, Search, Send, X, Users } from "lucide-react"

interface Group {
  id: string
  name: string
  contact_count?: number
}
interface Template {
  id: string
  name: string
  body: string
}
interface PlatformUser {
  id: string
  email: string | null
  phone_number: string | null
  first_name: string | null
  role: string | null
}

const ALL_CHANNELS = ["sms", "whatsapp", "email", "push"] as const
type Channel = (typeof ALL_CHANNELS)[number]

const ALL_ROLES = ["user", "dealer", "sub_agent", "admin"] as const
type Audience = "roles" | "specific" | "group"

export default function BroadcastTab() {
  const [groups, setGroups] = useState<Group[]>([])
  const [templates, setTemplates] = useState<Template[]>([])

  const [channels, setChannels] = useState<Channel[]>(["sms"])
  const [subject, setSubject] = useState("")
  const [message, setMessage] = useState("")

  const [audienceType, setAudienceType] = useState<Audience>("roles")
  const [roles, setRoles] = useState<string[]>(["user"])
  const [groupId, setGroupId] = useState("")
  const [mergeFields, setMergeFields] = useState(true)

  // Specific-user targeting (search + multi-select)
  const [allUsers, setAllUsers] = useState<PlatformUser[]>([])
  const [usersLoaded, setUsersLoaded] = useState(false)
  const [searchTerm, setSearchTerm] = useState("")
  const [selectedUsers, setSelectedUsers] = useState<PlatformUser[]>([])

  const [sending, setSending] = useState(false)

  useEffect(() => {
    api<Group[]>("/api/admin/sms-groups").then((r) => r.success && r.data && setGroups(r.data))
    api<Template[]>("/api/admin/sms-templates").then((r) => r.success && r.data && setTemplates(r.data))
  }, [])

  // Lazily load the platform user list the first time "specific" is selected.
  // Reuses adminMessagingService.getBroadcastRecipients() (the same source the
  // gold-standard /admin/broadcast composer uses).
  useEffect(() => {
    if (audienceType !== "specific" || usersLoaded) return
    setUsersLoaded(true)
    adminMessagingService
      .getBroadcastRecipients()
      .then((data: PlatformUser[]) => setAllUsers(data || []))
      .catch(() => {
        toast.error("Failed to load user list")
        setUsersLoaded(false)
      })
  }, [audienceType, usersLoaded])

  const toggle = useCallback(
    <T,>(setter: Dispatch<SetStateAction<T[]>>, value: T) =>
      setter((cur) => (cur.includes(value) ? cur.filter((x) => x !== value) : [...cur, value])),
    []
  )

  const seg = useMemo(() => calculateSegments(message), [message])
  const subjectRequired = channels.includes("email") || channels.includes("push")
  const selectedGroup = groups.find((g) => g.id === groupId)

  // Live personalised sample (group + merge fields), so the admin sees what a
  // recipient actually receives.
  const sample = useMemo(() => {
    if (audienceType === "group" && mergeFields && hasMergeTokens(message)) {
      return personalize(message, { firstName: "Ama", lastName: "Mensah", phone: "0241234567" })
    }
    return message
  }, [audienceType, mergeFields, message])

  const filteredSearch = useMemo(() => {
    const term = searchTerm.trim().toLowerCase()
    if (!term) return []
    return allUsers
      .filter(
        (u) =>
          u.email?.toLowerCase().includes(term) ||
          u.phone_number?.toLowerCase().includes(term) ||
          u.first_name?.toLowerCase().includes(term)
      )
      .slice(0, 10)
  }, [searchTerm, allUsers])

  const estimatedRecipients =
    audienceType === "group"
      ? selectedGroup?.contact_count
      : audienceType === "specific"
      ? selectedUsers.length
      : undefined
  const estimatedCredits =
    estimatedRecipients !== undefined ? seg.segments * estimatedRecipients : undefined

  function loadTemplate(id: string) {
    const t = templates.find((x) => x.id === id)
    if (t) setMessage(t.body)
  }

  function addUser(u: PlatformUser) {
    if (!selectedUsers.find((s) => s.id === u.id)) setSelectedUsers((cur) => [...cur, u])
    setSearchTerm("")
  }
  function removeUser(id: string) {
    setSelectedUsers((cur) => cur.filter((u) => u.id !== id))
  }

  async function send() {
    if (channels.length === 0) return toast.error("Select at least one channel.")
    if (!message.trim()) return toast.error("Message is required.")
    if (subjectRequired && !subject.trim()) return toast.error("Subject is required for email/push.")
    if (audienceType === "roles" && roles.length === 0) return toast.error("Select at least one role.")
    if (audienceType === "specific" && selectedUsers.length === 0) return toast.error("Select at least one user.")
    if (audienceType === "group" && !groupId) return toast.error("Select a group.")

    const recipients =
      audienceType === "group"
        ? { type: "group" as const, groupId }
        : audienceType === "specific"
        ? {
            type: "specific" as const,
            users: selectedUsers.map((u) => ({
              id: u.id,
              email: u.email,
              phone: u.phone_number,
              name: u.first_name,
            })),
          }
        : { type: "roles" as const, roles }

    const confirmMsg =
      audienceType === "group"
        ? `Send to group "${selectedGroup?.name}" (${estimatedRecipients ?? "?"} contacts) via ${channels.join(", ")}?`
        : audienceType === "specific"
        ? `Send to ${selectedUsers.length} selected user(s) via ${channels.join(", ")}?`
        : `Send to roles ${roles.join(", ")} via ${channels.join(", ")}?`
    if (!confirm(confirmMsg)) return

    setSending(true)
    const res = await api<unknown>("/api/admin/broadcast", {
      method: "POST",
      body: JSON.stringify({
        action: "init",
        channels,
        recipients,
        subject: subjectRequired ? subject : undefined,
        message,
        mergeFields: audienceType === "group" ? mergeFields : undefined,
      }),
    })
    setSending(false)

    // The broadcast route does NOT use the { success, data } envelope: success is
    // { success, broadcastId, total }, failure is { error }.
    const raw = res as { success?: boolean; broadcastId?: string; total?: number; error?: string }
    if (raw.success && raw.broadcastId) {
      toast.success(`Broadcast started — ${raw.total ?? 0} recipient(s) queued. It finishes server-side.`)
      setMessage("")
      setSubject("")
      setSelectedUsers([])
    } else {
      toast.error(raw.error ?? "Failed to start broadcast")
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
      {/* Compose column */}
      <div className="space-y-4">
        {/* Channels */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Channels</CardTitle>
            <CardDescription>Pick how this message is delivered.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-4">
              {ALL_CHANNELS.map((ch) => (
                <label key={ch} className="flex items-center gap-2 text-sm capitalize cursor-pointer">
                  <Checkbox checked={channels.includes(ch)} onCheckedChange={() => toggle(setChannels, ch)} />
                  {ch}
                </label>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Audience */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center justify-between text-base">
              <span className="flex items-center gap-2"><Users className="h-4 w-4" /> Audience</span>
              {estimatedRecipients !== undefined && (
                <Badge variant="secondary">{estimatedRecipients} recipient{estimatedRecipients === 1 ? "" : "s"}</Badge>
              )}
            </CardTitle>
            <CardDescription>Who should receive this message?</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap gap-1 rounded-lg bg-muted p-1">
              {([
                { id: "roles", label: "Platform roles" },
                { id: "specific", label: "Specific users" },
                { id: "group", label: "Address-book group" },
              ] as { id: Audience; label: string }[]).map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => setAudienceType(opt.id)}
                  className={`flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-all ${
                    audienceType === opt.id
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>

            {audienceType === "roles" && (
              <div className="grid grid-cols-2 gap-2">
                {ALL_ROLES.map((r) => (
                  <label
                    key={r}
                    className={`flex items-center gap-2 rounded-lg border p-2 text-sm cursor-pointer transition-colors ${
                      roles.includes(r) ? "border-primary bg-primary/5" : "hover:bg-accent"
                    }`}
                  >
                    <Checkbox checked={roles.includes(r)} onCheckedChange={() => toggle<string>(setRoles, r)} />
                    <span className="capitalize">{r.replace("_", " ")}</span>
                  </label>
                ))}
              </div>
            )}

            {audienceType === "specific" && (
              <div className="space-y-3">
                <div className="relative">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    placeholder={usersLoaded && allUsers.length === 0 ? "Loading users…" : "Search by name, email or phone…"}
                    className="pl-9"
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                  />
                  {searchTerm && filteredSearch.length > 0 && (
                    <div className="absolute z-10 mt-1 max-h-56 w-full overflow-y-auto rounded-lg border bg-popover shadow-lg">
                      {filteredSearch.map((u) => (
                        <button
                          key={u.id}
                          type="button"
                          onClick={() => addUser(u)}
                          className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-accent"
                        >
                          <span className="truncate">{u.email || u.phone_number || u.first_name || u.id}</span>
                          {u.role && <Badge variant="outline" className="shrink-0 text-[10px]">{u.role}</Badge>}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <div className="flex flex-wrap gap-2">
                  {selectedUsers.length === 0 ? (
                    <p className="text-xs text-muted-foreground">No users selected yet.</p>
                  ) : (
                    selectedUsers.map((u) => (
                      <Badge key={u.id} variant="secondary" className="flex items-center gap-1 py-1">
                        {u.email || u.phone_number || u.first_name}
                        <X className="h-3 w-3 cursor-pointer" onClick={() => removeUser(u.id)} />
                      </Badge>
                    ))
                  )}
                </div>
              </div>
            )}

            {audienceType === "group" && (
              <div className="space-y-2">
                <select
                  value={groupId}
                  onChange={(e) => setGroupId(e.target.value)}
                  className="w-full rounded-md border bg-transparent px-3 py-2 text-sm"
                >
                  <option value="">Select a group…</option>
                  {groups.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name} ({g.contact_count ?? 0})
                    </option>
                  ))}
                </select>
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <Checkbox checked={mergeFields} onCheckedChange={(v) => setMergeFields(Boolean(v))} />
                  <span>
                    Personalise <code className="text-xs">[FirstName] [LastName] [Phone]</code>
                  </span>
                </label>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Compose message */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center justify-between text-base">
              <span>Message</span>
              {templates.length > 0 && (
                <select
                  onChange={(e) => e.target.value && loadTemplate(e.target.value)}
                  value=""
                  className="rounded-md border bg-transparent px-2 py-1 text-xs"
                >
                  <option value="">Load template…</option>
                  {templates.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {subjectRequired && (
              <div className="space-y-1.5">
                <Label htmlFor="subject">Subject (email / push)</Label>
                <Input
                  id="subject"
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  placeholder="Enter subject line…"
                  maxLength={200}
                />
              </div>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="message">Message body</Label>
              <Textarea
                id="message"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="Type your message… use [FirstName], [LastName], [Phone] for group personalisation"
                rows={6}
              />
            </div>
            <Button onClick={send} disabled={sending}>
              {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              {sending ? "Sending…" : "Send broadcast"}
            </Button>
          </CardContent>
        </Card>
      </div>

      {/* Live preview + estimate */}
      <aside className="space-y-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Preview</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="min-h-[5rem] whitespace-pre-wrap rounded-2xl rounded-bl-sm bg-primary/10 p-3 text-sm">
              {sample || <span className="text-muted-foreground">Nothing to preview yet.</span>}
            </div>
            {audienceType === "group" && mergeFields && hasMergeTokens(message) && (
              <p className="text-xs text-muted-foreground">Sample personalisation shown (Ama Mensah · 0241234567).</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Estimate</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            <Row label="Characters" value={String(message.length)} />
            <Row label="Encoding" value={seg.encoding.toUpperCase()} />
            <Row label="Segments / recipient" value={String(seg.segments)} />
            <Row label="Recipients" value={estimatedRecipients !== undefined ? String(estimatedRecipients) : "—"} />
            <Row label="Est. SMS credits" value={estimatedCredits !== undefined ? String(estimatedCredits) : "—"} />
            {channels.includes("sms") && seg.segments > 1 && (
              <Alert className="mt-2">
                <AlertDescription className="text-xs">
                  Long message: {seg.segments} segments billed per SMS recipient.
                </AlertDescription>
              </Alert>
            )}
          </CardContent>
        </Card>
      </aside>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  )
}
