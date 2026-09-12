"use client"

import { useEffect, useState } from "react"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Loader2, Plus, Pencil, Trash2 } from "lucide-react"
import { supabase } from "@/lib/supabase"
import { toast } from "sonner"

type DomainService = "data_bundles" | "airtime" | "results_checker" | "bulk_sms"

interface CustomDomainRow {
  id: string
  domain: string
  services: DomainService[]
  site_name: string
  logo_url: string | null
  primary_color: string | null
  is_active: boolean
  created_at: string
  updated_at: string
}

const SERVICE_LABELS: Record<DomainService, string> = {
  data_bundles: "Data Bundles",
  airtime: "Airtime",
  results_checker: "Results Checker",
  bulk_sms: "Bulk SMS",
}

const ALL_SERVICES = Object.keys(SERVICE_LABELS) as DomainService[]

const EMPTY_FORM = { domain: "", services: [] as DomainService[], site_name: "", logo_url: "", primary_color: "" }

export default function CustomDomainsPage() {
  const [domains, setDomains] = useState<CustomDomainRow[]>([])
  const [loading, setLoading] = useState(true)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<CustomDomainRow | null>(null)
  const [form, setForm] = useState(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [uploadingLogo, setUploadingLogo] = useState(false)

  const authHeader = async () => {
    const { data: { session } } = await supabase.auth.getSession()
    return { Authorization: `Bearer ${session?.access_token}` }
  }

  const loadDomains = async () => {
    setLoading(true)
    try {
      const res = await fetch("/api/admin/custom-domains", { headers: await authHeader() })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error || "Failed to load domains")
      setDomains(body.domains || [])
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load domains")
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadDomains()
  }, [])

  const openCreate = () => {
    setEditing(null)
    setForm(EMPTY_FORM)
    setDialogOpen(true)
  }

  const openEdit = (row: CustomDomainRow) => {
    setEditing(row)
    setForm({
      domain: row.domain,
      services: row.services,
      site_name: row.site_name,
      logo_url: row.logo_url || "",
      primary_color: row.primary_color || "",
    })
    setDialogOpen(true)
  }

  const toggleService = (service: DomainService) => {
    setForm(f => ({
      ...f,
      services: f.services.includes(service)
        ? f.services.filter(s => s !== service)
        : [...f.services, service],
    }))
  }

  const handleLogoUpload = async (file: File) => {
    setUploadingLogo(true)
    try {
      const path = `custom-domains/${Date.now()}-${file.name.replace(/[^a-zA-Z0-9.-]/g, "_")}`
      const { error: uploadError } = await supabase.storage.from("admin-uploads").upload(path, file, { upsert: true })
      if (uploadError) throw uploadError
      const { data } = supabase.storage.from("admin-uploads").getPublicUrl(path)
      setForm(f => ({ ...f, logo_url: data.publicUrl }))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Logo upload failed")
    } finally {
      setUploadingLogo(false)
    }
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      const headers = { "Content-Type": "application/json", ...(await authHeader()) }
      const res = editing
        ? await fetch("/api/admin/custom-domains", {
            method: "PATCH",
            headers,
            body: JSON.stringify({
              id: editing.id,
              services: form.services,
              site_name: form.site_name,
              logo_url: form.logo_url || null,
              primary_color: form.primary_color || null,
            }),
          })
        : await fetch("/api/admin/custom-domains", {
            method: "POST",
            headers,
            body: JSON.stringify({
              domain: form.domain,
              services: form.services,
              site_name: form.site_name,
              logo_url: form.logo_url || null,
              primary_color: form.primary_color || null,
            }),
          })

      const body = await res.json()
      if (!res.ok) throw new Error(body.error || "Save failed")

      toast.success(editing ? "Domain updated" : "Domain added")
      setDialogOpen(false)
      await loadDomains()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed")
    } finally {
      setSaving(false)
    }
  }

  const handleToggleActive = async (row: CustomDomainRow) => {
    try {
      const headers = { "Content-Type": "application/json", ...(await authHeader()) }
      const res = await fetch("/api/admin/custom-domains", {
        method: "PATCH",
        headers,
        body: JSON.stringify({ id: row.id, is_active: !row.is_active }),
      })
      if (!res.ok) throw new Error((await res.json()).error || "Update failed")
      await loadDomains()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Update failed")
    }
  }

  const handleDelete = async (row: CustomDomainRow) => {
    if (!confirm(`Remove "${row.domain}"? This cannot be undone.`)) return
    try {
      const res = await fetch(`/api/admin/custom-domains?id=${row.id}`, { method: "DELETE", headers: await authHeader() })
      if (!res.ok) throw new Error((await res.json()).error || "Delete failed")
      toast.success("Domain removed")
      await loadDomains()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Delete failed")
    }
  }

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">Custom Domains</h1>
            <p className="text-sm text-muted-foreground">
              Point a domain you own at one or more services, with its own name/logo/color. Accounts, wallet, and orders stay shared with the main site.
            </p>
          </div>
          <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
            <DialogTrigger asChild>
              <Button onClick={openCreate}><Plus className="w-4 h-4 mr-2" /> Add Domain</Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>{editing ? "Edit Domain" : "Add Domain"}</DialogTitle>
              </DialogHeader>
              <div className="space-y-4 py-2">
                <div className="space-y-2">
                  <Label>Domain</Label>
                  <Input
                    value={form.domain}
                    onChange={e => setForm(f => ({ ...f, domain: e.target.value }))}
                    placeholder="checkresults.com"
                    disabled={!!editing}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Services</Label>
                  <div className="space-y-2">
                    {ALL_SERVICES.map(s => (
                      <label key={s} className="flex items-center gap-2 text-sm cursor-pointer">
                        <Checkbox checked={form.services.includes(s)} onCheckedChange={() => toggleService(s)} />
                        {SERVICE_LABELS[s]}
                      </label>
                    ))}
                  </div>
                </div>
                <div className="space-y-2">
                  <Label>Site Name</Label>
                  <Input value={form.site_name} onChange={e => setForm(f => ({ ...f, site_name: e.target.value }))} placeholder="CheckResults" />
                </div>
                <div className="space-y-2">
                  <Label>Logo</Label>
                  <div className="flex items-center gap-3">
                    {form.logo_url && <img src={form.logo_url} alt="Logo preview" className="w-10 h-10 rounded object-cover" />}
                    <Input
                      type="file"
                      accept="image/*"
                      disabled={uploadingLogo}
                      onChange={e => e.target.files?.[0] && handleLogoUpload(e.target.files[0])}
                    />
                    {uploadingLogo && <Loader2 className="w-4 h-4 animate-spin" />}
                  </div>
                </div>
                <div className="space-y-2">
                  <Label>Primary Color</Label>
                  <div className="flex items-center gap-3">
                    <input
                      type="color"
                      value={form.primary_color || "#059669"}
                      onChange={e => setForm(f => ({ ...f, primary_color: e.target.value }))}
                      className="w-10 h-10 rounded border border-border"
                    />
                    <Input value={form.primary_color} onChange={e => setForm(f => ({ ...f, primary_color: e.target.value }))} placeholder="#059669" />
                  </div>
                </div>
              </div>
              <DialogFooter>
                <Button onClick={handleSave} disabled={saving || !form.domain || !form.site_name || form.services.length === 0}>
                  {saving ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
                  {editing ? "Save Changes" : "Add Domain"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Configured Domains</CardTitle>
            <CardDescription>
              Saving here does not attach the domain in Vercel or point its DNS — add it under your Vercel project&apos;s Settings → Domains and point DNS per Vercel&apos;s instructions.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="flex justify-center py-8"><Loader2 className="w-6 h-6 animate-spin" /></div>
            ) : domains.length === 0 ? (
              <p className="text-sm text-muted-foreground py-8 text-center">No custom domains configured yet.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Domain</TableHead>
                    <TableHead>Services</TableHead>
                    <TableHead>Site Name</TableHead>
                    <TableHead>Active</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {domains.map(row => (
                    <TableRow key={row.id}>
                      <TableCell className="font-medium">{row.domain}</TableCell>
                      <TableCell className="space-x-1">
                        {row.services.map(s => <Badge key={s} variant="outline">{SERVICE_LABELS[s]}</Badge>)}
                      </TableCell>
                      <TableCell className="flex items-center gap-2">
                        {row.logo_url && <img src={row.logo_url} alt="" className="w-5 h-5 rounded object-cover" />}
                        {row.site_name}
                      </TableCell>
                      <TableCell><Switch checked={row.is_active} onCheckedChange={() => handleToggleActive(row)} /></TableCell>
                      <TableCell className="text-right space-x-2">
                        <Button variant="ghost" size="icon" onClick={() => openEdit(row)}><Pencil className="w-4 h-4" /></Button>
                        <Button variant="ghost" size="icon" onClick={() => handleDelete(row)}><Trash2 className="w-4 h-4 text-destructive" /></Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  )
}
