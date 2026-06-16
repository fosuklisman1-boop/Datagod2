"use client"

import { useCallback, useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react"
import { api } from "../_lib/api"
import { calculateSegments } from "@/lib/sms/segments"
import { personalize, hasMergeTokens } from "@/lib/sms/personalize"

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

const ALL_CHANNELS = ["sms", "whatsapp", "email", "push"] as const
type Channel = (typeof ALL_CHANNELS)[number]

const ALL_ROLES = ["user", "dealer", "sub_agent", "admin"] as const

export default function BroadcastTab() {
  const [groups, setGroups] = useState<Group[]>([])
  const [templates, setTemplates] = useState<Template[]>([])

  const [channels, setChannels] = useState<Channel[]>(["sms"])
  const [subject, setSubject] = useState("")
  const [message, setMessage] = useState("")

  const [audienceType, setAudienceType] = useState<"roles" | "group">("roles")
  const [roles, setRoles] = useState<string[]>(["user"])
  const [groupId, setGroupId] = useState("")
  const [mergeFields, setMergeFields] = useState(true)

  const [sending, setSending] = useState(false)
  const [msg, setMsg] = useState("")

  useEffect(() => {
    api<Group[]>("/api/admin/sms-groups").then((r) => r.success && r.data && setGroups(r.data))
    api<Template[]>("/api/admin/sms-templates").then((r) => r.success && r.data && setTemplates(r.data))
  }, [])

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

  const estimatedRecipients = audienceType === "group" ? selectedGroup?.contact_count : undefined
  const estimatedCredits =
    estimatedRecipients !== undefined ? seg.segments * estimatedRecipients : undefined

  function loadTemplate(id: string) {
    const t = templates.find((x) => x.id === id)
    if (t) setMessage(t.body)
  }

  async function send() {
    setMsg("")
    if (channels.length === 0) return setMsg("Select at least one channel.")
    if (!message.trim()) return setMsg("Message is required.")
    if (subjectRequired && !subject.trim()) return setMsg("Subject is required for email/push.")
    if (audienceType === "roles" && roles.length === 0) return setMsg("Select at least one role.")
    if (audienceType === "group" && !groupId) return setMsg("Select a group.")

    const recipients =
      audienceType === "group"
        ? { type: "group" as const, groupId }
        : { type: "roles" as const, roles }

    const confirmMsg =
      audienceType === "group"
        ? `Send to group “${selectedGroup?.name}” (${estimatedRecipients ?? "?"} contacts) via ${channels.join(", ")}?`
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

    const raw = res as { success?: boolean; broadcastId?: string; total?: number; error?: string }
    if (raw.success && raw.broadcastId) {
      setMsg(`✅ Broadcast started — ${raw.total} recipient(s) queued. It will finish server-side.`)
      setMessage("")
    } else {
      setMsg(`Error: ${raw.error ?? "failed to start broadcast"}`)
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
      {/* Compose */}
      <div className="space-y-4">
        {msg && <p className="text-sm rounded border bg-muted/40 px-3 py-2">{msg}</p>}

        {/* Channels */}
        <section className="rounded-lg border p-4 space-y-2">
          <label className="block text-sm font-medium">Channels</label>
          <div className="flex flex-wrap gap-3">
            {ALL_CHANNELS.map((ch) => (
              <label key={ch} className="flex items-center gap-1.5 text-sm capitalize">
                <input type="checkbox" checked={channels.includes(ch)} onChange={() => toggle(setChannels, ch)} />
                {ch}
              </label>
            ))}
          </div>
        </section>

        {/* Audience */}
        <section className="rounded-lg border p-4 space-y-3">
          <label className="block text-sm font-medium">Audience</label>
          <div className="flex gap-4 text-sm">
            <label className="flex items-center gap-1.5">
              <input type="radio" checked={audienceType === "roles"} onChange={() => setAudienceType("roles")} />
              Platform users (by role)
            </label>
            <label className="flex items-center gap-1.5">
              <input type="radio" checked={audienceType === "group"} onChange={() => setAudienceType("group")} />
              Address-book group
            </label>
          </div>

          {audienceType === "roles" && (
            <div className="flex flex-wrap gap-3">
              {ALL_ROLES.map((r) => (
                <label key={r} className="flex items-center gap-1.5 text-sm">
                  <input type="checkbox" checked={roles.includes(r)} onChange={() => toggle<string>(setRoles, r)} />
                  {r}
                </label>
              ))}
            </div>
          )}

          {audienceType === "group" && (
            <div className="space-y-2">
              <select
                value={groupId}
                onChange={(e) => setGroupId(e.target.value)}
                className="w-full rounded border px-2 py-1 text-sm"
              >
                <option value="">Select a group…</option>
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name} ({g.contact_count ?? 0})
                  </option>
                ))}
              </select>
              <label className="flex items-center gap-1.5 text-sm">
                <input type="checkbox" checked={mergeFields} onChange={(e) => setMergeFields(e.target.checked)} />
                Personalise <code className="text-xs">[FirstName] [LastName] [Phone]</code>
              </label>
            </div>
          )}
        </section>

        {/* Compose message */}
        <section className="rounded-lg border p-4 space-y-2">
          <div className="flex items-center justify-between">
            <label className="block text-sm font-medium">Message</label>
            {templates.length > 0 && (
              <select
                onChange={(e) => e.target.value && loadTemplate(e.target.value)}
                value=""
                className="rounded border px-2 py-0.5 text-xs"
              >
                <option value="">Load template…</option>
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            )}
          </div>

          {subjectRequired && (
            <input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Subject (email/push)"
              maxLength={200}
              className="w-full rounded border px-2 py-1 text-sm"
            />
          )}

          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="Type your message… use [FirstName], [LastName], [Phone] for group personalisation"
            rows={6}
            className="w-full rounded border px-2 py-1 text-sm"
          />

          <button
            onClick={send}
            disabled={sending}
            className="rounded bg-primary px-4 py-1.5 text-sm text-primary-foreground disabled:opacity-50"
          >
            {sending ? "Sending…" : "Send broadcast"}
          </button>
        </section>
      </div>

      {/* Live preview / estimate — the right rail updates as you type */}
      <aside className="space-y-4">
        <section className="rounded-lg border p-4 space-y-2">
          <h3 className="text-sm font-semibold">Preview</h3>
          <div className="min-h-[5rem] whitespace-pre-wrap rounded bg-muted/40 p-2 text-sm">
            {sample || <span className="text-muted-foreground">Nothing to preview yet.</span>}
          </div>
          {audienceType === "group" && mergeFields && hasMergeTokens(message) && (
            <p className="text-xs text-muted-foreground">Sample personalisation shown (Ama Mensah · 0241234567).</p>
          )}
        </section>

        <section className="rounded-lg border p-4 space-y-1 text-sm">
          <h3 className="text-sm font-semibold">Estimate</h3>
          <Row label="Characters" value={String(message.length)} />
          <Row label="Encoding" value={seg.encoding.toUpperCase()} />
          <Row label="Segments / recipient" value={String(seg.segments)} />
          <Row
            label="Recipients"
            value={estimatedRecipients !== undefined ? String(estimatedRecipients) : "—"}
          />
          <Row
            label="Est. SMS credits"
            value={estimatedCredits !== undefined ? String(estimatedCredits) : "—"}
          />
          {channels.includes("sms") && seg.segments > 1 && (
            <p className="pt-1 text-xs text-amber-600">
              Long message: {seg.segments} segments billed per SMS recipient.
            </p>
          )}
        </section>
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
