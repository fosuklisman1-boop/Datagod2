"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Loader2, Send } from "lucide-react"
import { calculateSegments } from "@/lib/sms/segments"
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { smsFetch } from "../_lib/api"
import { useSmsAccount } from "../_lib/useSmsAccount"
import { addNumbers, costSummary, formatScheduled, fromLocalInputValue, resolveTokens, scheduleError, sendErrorMessage, sendOutcomeMessage, MAX_RECIPIENTS, type ShopTokens } from "../_lib/view"
import { SchedulePicker } from "../_components/compose/SchedulePicker"
import { SmsShell } from "../_components/SmsShell"
import { RecipientsPicker } from "../_components/compose/RecipientsPicker"
import { MessageEditor } from "../_components/compose/MessageEditor"
import { SenderSelect } from "../_components/compose/SenderSelect"
import { ProviderSelect, type SmsProviderValue } from "@/components/sms/ProviderSelect"
import { CostSummary } from "../_components/compose/CostSummary"
import { TemplatesDrawer } from "../_components/compose/TemplatesDrawer"
import { PolicyNote } from "../_components/compose/PolicyNote"
import { usePolicyPreview } from "../_components/compose/usePolicyPreview"
import type { ComposeCustomer, ComposeGroup, ComposeSender, TenantTemplate } from "../_components/compose/types"

interface SendConfirm { open: boolean; loading: boolean; sentCount: number; activeCount: number }
const CLOSED_CONFIRM: SendConfirm = { open: false, loading: false, sentCount: 0, activeCount: 0 }

export default function SmsComposePage() {
  const router = useRouter()
  const { account, featureEnabled, reload, defaultSender, platformSender, senderPool } = useSmsAccount()

  const [message, setMessage] = useState("")
  const [recipients, setRecipients] = useState<string[]>([])
  const [selectedSenderId, setSelectedSenderId] = useState("") // "" = default
  const [selectedGroupId, setSelectedGroupId] = useState("")
  const [providerChoice, setProviderChoice] = useState(false) // admin enabled per-send provider choice
  const [provider, setProvider] = useState<SmsProviderValue>("")
  const [sending, setSending] = useState(false)
  const [busy, setBusy] = useState(false)
  const [sendConfirm, setSendConfirm] = useState<SendConfirm>(CLOSED_CONFIRM)
  const [templatesOpen, setTemplatesOpen] = useState(false)
  const [sendLater, setSendLater] = useState(false)
  const [scheduleValue, setScheduleValue] = useState("") // datetime-local, read as GMT

  const [senders, setSenders] = useState<ComposeSender[]>([])
  const [groups, setGroups] = useState<ComposeGroup[]>([])
  const [groupsLoaded, setGroupsLoaded] = useState(false)
  const [tokens, setTokens] = useState<ShopTokens | null>(null)
  const [customers, setCustomers] = useState<ComposeCustomer[]>([])
  const [templates, setTemplates] = useState<TenantTemplate[]>([])

  const loadSenderIds = useCallback(async () => {
    const r = await smsFetch<ComposeSender[]>("/api/sms/sender-ids")
    if (r.ok) setSenders(Array.isArray(r.data) ? r.data : [])
    else toast.error("Could not load your sender IDs.")
  }, [])

  const loadComposeContext = useCallback(async () => {
    const [ctx, tpl] = await Promise.all([
      smsFetch<{ tokens: ShopTokens; customers?: ComposeCustomer[]; providerChoice?: boolean }>("/api/sms/context"),
      smsFetch<TenantTemplate[]>("/api/sms/templates"),
    ])
    // Non-fatal: compose still works without tokens/customers.
    if (ctx.ok) { setTokens(ctx.data.tokens ?? null); setCustomers(ctx.data.customers ?? []); setProviderChoice(ctx.data.providerChoice === true) }
    if (tpl.ok) setTemplates(Array.isArray(tpl.data) ? tpl.data : [])
  }, [])

  const loadGroups = useCallback(async () => {
    const r = await smsFetch<ComposeGroup[]>("/api/sms/groups")
    if (r.ok) setGroups(Array.isArray(r.data) ? r.data : [])
    else toast.error("Could not load your contact groups.")
    setGroupsLoaded(true)
  }, [])

  useEffect(() => { void loadSenderIds(); void loadComposeContext(); void loadGroups() }, [loadSenderIds, loadComposeContext, loadGroups])

  // ── recipients ──
  function addRecipients(raw: string) {
    setRecipients((cur) => {
      const { list, capped } = addNumbers(cur, raw)
      if (capped) toast.warning(`Recipient limit is ${MAX_RECIPIENTS}.`)
      return list
    })
  }
  function removeRecipient(n: string) { setRecipients((cur) => cur.filter((x) => x !== n)) }

  // ── templates ──
  async function saveTemplate(rawName: string): Promise<boolean> {
    const name = rawName.trim()
    if (!name) { toast.error("Give the template a name."); return false }
    if (!message.trim()) { toast.error("Write a message first."); return false }
    setBusy(true)
    const r = await smsFetch("/api/sms/templates", { method: "POST", body: JSON.stringify({ name, body: message }) })
    setBusy(false)
    if (r.ok) { toast.success("Template saved."); await loadComposeContext(); return true }
    toast.error(r.error ?? "Could not save template")
    return false
  }
  async function deleteTemplate(id: string) {
    setBusy(true)
    const r = await smsFetch(`/api/sms/templates/${id}`, { method: "DELETE" })
    setBusy(false)
    if (r.ok) setTemplates((cur) => cur.filter((x) => x.id !== id))
    else toast.error(r.error ?? "Could not delete template")
  }
  function loadTemplate(t: TenantTemplate) {
    setMessage(t.body)
    setTemplatesOpen(false)
    toast.success(`Loaded “${t.name}”`)
  }

  // ── derived ──
  const resolved = useMemo(() => resolveTokens(message, tokens), [message, tokens])
  const meter = useMemo(() => calculateSegments(resolved), [resolved])
  const segPerRecipient = resolved.length === 0 ? 0 : meter.segments
  const composeGroup = groups.find((g) => g.id === selectedGroupId) ?? null
  // Estimate only: the server resolves the group's active contacts authoritatively.
  const estRecipients = recipients.length + (composeGroup?.contact_count ?? 0)
  const balance = account?.unitBalance ?? 0
  const cost = costSummary(estRecipients, segPerRecipient, balance)
  // Group counts include opted-out contacts (upper bound), so over-budget is advisory for
  // groups; for manual-only sends the count is exact, so it hard-blocks.
  const overBudgetBlocks = estRecipients > 0 && cost.overBudget && !selectedGroupId
  const isActive = account?.status === "active"
  const isPlatform = account?.ownerType === "platform"
  const isSuspended = account?.status === "suspended"
  const canSend = (isActive || isPlatform) && !isSuspended && featureEnabled !== false
  const scheduleIso = sendLater ? fromLocalInputValue(scheduleValue) : null
  const scheduleInvalid = sendLater && scheduleError(scheduleIso, new Date()) !== null
  const sendDisabled =
    !canSend || sending || message.trim().length < 3 ||
    (recipients.length === 0 && !selectedGroupId) || overBudgetBlocks || scheduleInvalid

  const policy = usePolicyPreview(message, selectedSenderId, estRecipients)

  const confirmTotal = sendConfirm.sentCount + recipients.length
  const confirmBatches = Math.ceil(confirmTotal / 500)
  const confirmCost = confirmTotal * segPerRecipient

  // ── send ──
  // Group sends aren't visible as chips and can be large, so confirm the REAL
  // (opt-out-filtered, server-counted) recipient count + credit cost before spending.
  async function sendMessage() {
    if (!account || message.length < 3 || (recipients.length === 0 && !selectedGroupId)) return
    if (selectedGroupId) {
      setSendConfirm({ open: true, loading: true, sentCount: 0, activeCount: 0 })
      const r = await smsFetch<{ sentCount: number; activeCount: number }>(`/api/sms/groups/${selectedGroupId}/preview`)
      if (r.ok) {
        setSendConfirm({ open: true, loading: false, sentCount: r.data.sentCount, activeCount: r.data.activeCount })
      } else {
        setSendConfirm(CLOSED_CONFIRM)
        toast.error(r.error ?? "Could not check the group size.")
      }
      return
    }
    await doSend()
  }

  async function doSend() {
    if (!account) return
    // Re-check at click time: the time may have drifted inside the 2-minute minimum while the page sat open.
    const at = sendLater ? fromLocalInputValue(scheduleValue) : null
    if (sendLater) {
      const err = scheduleError(at, new Date())
      if (err) { setSendConfirm((c) => ({ ...c, open: false })); toast.error(err); return }
    }
    setSendConfirm((c) => ({ ...c, open: false }))
    setSending(true)
    const r = await smsFetch<{ total?: number; creditsReserved?: number; batches?: number; partial?: boolean; stoppedReason?: string; held?: boolean; scheduled?: boolean; scheduledFor?: string | null; sendLogId?: string | number | null }>(
      "/api/shop/sms/send",
      { method: "POST", body: JSON.stringify({ message, recipients, groupId: selectedGroupId || undefined, senderId: selectedSenderId || undefined, ...(providerChoice && provider ? { provider } : {}), ...(at ? { scheduledAt: at } : {}) }) },
    )
    setSending(false)
    if (!r.ok) {
      const reason = typeof r.body.reason === "string" ? r.body.reason : undefined
      const msg = typeof r.body.message === "string" ? r.body.message : undefined
      toast.error(sendErrorMessage(r.error, reason, msg))
      return
    }
    // Held and partial can both be true (e.g. chunk 1 held, chunk 2 out of credits): show both.
    const outcome = sendOutcomeMessage(r.data ?? {})
    if (outcome.tone === "warning") toast.warning(outcome.text)
    else toast.success(outcome.text)
    setMessage(""); setRecipients([]); setSelectedGroupId(""); setSendLater(false); setScheduleValue("")
    void reload()
    router.push("/dashboard/sms/records")
  }

  return (
    <SmsShell backToHome subtitle="Compose a message and send it to your customers.">
      <Card className="clay">
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Send className="h-5 w-5 text-primary" /> Compose Message</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {!canSend && account && (
            <Alert className="border-warning/30 bg-warning/10">
              <AlertDescription>
                {isSuspended
                  ? "Your SMS account is suspended, so sending is unavailable."
                  : featureEnabled === false
                    ? "SMS is temporarily unavailable. Sending is paused."
                    : "Activate SMS on the SMS home page before sending."}
              </AlertDescription>
            </Alert>
          )}

          <SenderSelect
            senders={senders}
            value={selectedSenderId}
            onChange={setSelectedSenderId}
            defaultSender={defaultSender}
            platformSender={platformSender}
            pool={senderPool}
          />

          {providerChoice && (
            <ProviderSelect id="sms-provider" label="Delivery provider" value={provider} onChange={setProvider} />
          )}

          <RecipientsPicker
            recipients={recipients}
            onAdd={addRecipients}
            onRemove={removeRecipient}
            customers={customers}
            groups={groups}
            groupsLoaded={groupsLoaded}
            selectedGroupId={selectedGroupId}
            onGroupChange={setSelectedGroupId}
          />

          <MessageEditor
            message={message}
            onChange={setMessage}
            resolved={resolved}
            busy={busy}
            onSaveTemplate={saveTemplate}
            onOpenTemplates={() => setTemplatesOpen(true)}
            templateCount={templates.length}
          />

          <CostSummary
            chars={resolved.length}
            segPerRecipient={segPerRecipient}
            estRecipients={estRecipients}
            hasGroup={!!composeGroup}
            balance={balance}
          />

          <PolicyNote preview={policy} />

          <SchedulePicker
            enabled={sendLater} onEnabledChange={setSendLater}
            value={scheduleValue} onValueChange={setScheduleValue}
            iso={scheduleIso} disabled={sending}
          />

          <Button onClick={sendMessage} disabled={sendDisabled} className="w-full" size="lg">
            {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            {sending ? (sendLater ? "Scheduling…" : "Sending…") : sendLater ? "Schedule SMS" : "Send SMS"}
          </Button>

          {/* Group-send confirmation: real opt-out-filtered count + cost */}
          <AlertDialog open={sendConfirm.open} onOpenChange={(o) => setSendConfirm((c) => ({ ...c, open: o }))}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{sendLater ? "Schedule to this group?" : "Send to this group?"}</AlertDialogTitle>
                <AlertDialogDescription asChild>
                  {sendConfirm.loading ? (
                    <div className="flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" /> Checking group size…</div>
                  ) : (
                    <div>
                      {sendLater && scheduleIso ? <span className="mb-2 block">Scheduled for <span className="font-medium text-foreground">{formatScheduled(scheduleIso)}</span>.</span> : null}
                      This will {sendLater ? "schedule a send to" : "send to"} <span className="font-medium text-foreground">{confirmTotal}</span> recipient{confirmTotal === 1 ? "" : "s"}
                      {recipients.length > 0 ? <> ({sendConfirm.sentCount} from the group + {recipients.length} typed)</> : null}
                      {confirmTotal > 500 ? <> — auto-split into <span className="font-medium text-foreground">{confirmBatches}</span> batches of up to 500</> : null} for about <span className="font-medium text-foreground">{confirmCost}</span> credit{confirmCost === 1 ? "" : "s"} (opted-out numbers skipped; duplicates merged).
                      {sendConfirm.activeCount > sendConfirm.sentCount && (
                        <span className="mt-2 block text-amber-600">Group has {sendConfirm.activeCount} active contacts, above the {sendConfirm.sentCount}-per-send limit — only the first {sendConfirm.sentCount} will be sent; send the rest separately.</span>
                      )}
                    </div>
                  )}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={doSend} disabled={sendConfirm.loading || confirmTotal === 0}>
                  {sendLater ? "Schedule to" : "Send to"} {confirmTotal}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </CardContent>
      </Card>

      <TemplatesDrawer
        open={templatesOpen}
        onOpenChange={setTemplatesOpen}
        templates={templates}
        busy={busy}
        onLoad={loadTemplate}
        onDelete={deleteTemplate}
      />
    </SmsShell>
  )
}
