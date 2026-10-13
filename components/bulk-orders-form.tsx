"use client"

import { useState, useEffect, useRef } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { toast } from "sonner"
import { Download, CheckCircle, AlertCircle } from "lucide-react"
import { supabase } from "@/lib/supabase"
import { validatePhoneNumber } from "@/lib/phone-validation"
import { applyPriceAdjustmentsToPackages } from "@/lib/price-adjustment-service"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"

interface ValidationResult {
  total: number
  valid: number
  invalid: number
  orders: Array<{
    id: number
    phone: string
    volume: number
    price: number
    status: "valid" | "invalid"
    reason: string
    /** MTN live-verification result, checked at validate time (not
     *  submit time) so "Place order" can go straight through unless
     *  something actually needs a warning. Undefined for invalid rows
     *  and for non-MTN networks, which have no live verification. */
    verified?: boolean
  }>
}

interface BulkOrdersFormProps {
  /** Real network label (e.g. "MTN", "AT - iShare"), driven by an external
   *  network picker. When set, the form's own network dropdown is hidden
   *  and locked to this network instead. */
  presetNetwork?: string
}

export function BulkOrdersForm({ presetNetwork }: BulkOrdersFormProps = {}) {
  const [activeTab, setActiveTab] = useState<"excel" | "text">("text")
  const [selectedNetwork, setSelectedNetwork] = useState("")
  const [textInput, setTextInput] = useState("")
  const [isValidating, setIsValidating] = useState(false)
  const [validationResults, setValidationResults] = useState<ValidationResult | null>(null)
  const [packages, setPackages] = useState<Array<{ network: string; size: number; price: number }>>([])
  const [networks, setNetworks] = useState<Array<{ id: string; label: string }>>([])
  const [loading, setLoading] = useState(true)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [walletBalance, setWalletBalance] = useState<number | null>(null)
  const [batchVerifyWarning, setBatchVerifyWarning] = useState<{
    unverifiedPhones: string[]
    ordersToSubmit: ValidationResult["orders"]
    networkLabel: string
  } | null>(null)
  const excelFileInput = useRef<HTMLInputElement | null>(null)

  // Load packages from database on mount
  useEffect(() => {
    loadPackages()
    loadWalletBalance()
  }, [])

  const loadWalletBalance = async () => {
    const { data: { session } } = await supabase.auth.getSession()
    if (!session?.user?.id) return
    const { data } = await supabase.from("wallets").select("balance").eq("user_id", session.user.id).maybeSingle()
    setWalletBalance(data?.balance ?? 0)
  }

  // Lock the internal network selection to the externally-picked network
  // once its matching entry has loaded, and drop any validation run against
  // a previously-picked network so stale results can't be submitted.
  useEffect(() => {
    if (!presetNetwork) return
    const match = networks.find((n) => n.label === presetNetwork)
    if (!match || match.id === selectedNetwork) return
    setSelectedNetwork(match.id)
    setTextInput("")
    setValidationResults(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presetNetwork, networks])

  const loadPackages = async () => {
    try {
      // Get user role first
      const { data: { session } } = await supabase.auth.getSession()
      let userRole = "user"

      if (session?.user) {
        const { data: userData } = await supabase
          .from("users")
          .select("role")
          .eq("id", session.user.id)
          .single()
        userRole = userData?.role || "user"
      }

      const { data, error } = await supabase
        .from("packages")
        .select("*, dealer_price")
        .eq("active", true)
        .order("network", { ascending: true })
        .order("size", { ascending: true })

      if (error) throw error

      if (data) {
        // Apply price adjustments based on network settings
        const adjustedData = await applyPriceAdjustmentsToPackages(data)

        // Transform data to match our format
        const transformedPackages = adjustedData.map((pkg: any) => ({
          network: pkg.network,
          size: parseFloat(pkg.size),
          price: userRole === "dealer" && pkg.dealer_price && pkg.dealer_price > 0
            ? pkg.dealer_price
            : pkg.price,
        }))

        setPackages(transformedPackages)

        // Extract unique networks and create network list
        const uniqueNetworks = [...new Set(adjustedData.map((pkg: any) => pkg.network))]
        const networkList = uniqueNetworks.map((network: string) => ({
          id: network.toLowerCase().replace(/\s+/g, ""),
          label: network,
        }))
        setNetworks(networkList)

        console.log("Loaded packages from database:", transformedPackages)
        console.log("Available networks:", networkList)
      }
    } catch (error) {
      console.error("Error loading packages from database:", error)
      const errorMessage = error instanceof Error ? error.message : "Failed to load packages from database"
      toast.error(errorMessage)
    } finally {
      setLoading(false)
    }
  }

  const parseAndValidate = (input: string) => {
    const lines = input.trim().split("\n")
    const orders: ValidationResult["orders"] = []
    let valid = 0
    let invalid = 0

    // Get selected network from the networks list
    const selectedNetworkLabel = networks.find(n => n.id === selectedNetwork)?.label

    if (!selectedNetworkLabel) {
      toast.error("Invalid network selected")
      return { total: 0, valid: 0, invalid: 0, orders: [] }
    }

    // Get available packages for selected network
    const availablePackages = packages.filter(pkg => pkg.network === selectedNetworkLabel)
    const availableVolumes = availablePackages.map(pkg => pkg.size)

    lines.forEach((line, index) => {
      const trimmedLine = line.trim()
      if (!trimmedLine) return

      const parts = trimmedLine.split(/\s+/)
      const id = index + 1

      if (parts.length !== 2) {
        invalid++
        orders.push({
          id,
          phone: parts[0] || "N/A",
          volume: 0,
          price: 0,
          status: "invalid",
          reason: "Invalid format. Expected: phone_number volume",
        })
        return
      }

      const [phone, volume] = parts

      // Validate phone using shared utility
      const phoneResult = validatePhoneNumber(phone, selectedNetworkLabel)
      if (!phoneResult.isValid) {
        invalid++
        orders.push({
          id,
          phone,
          volume: 0,
          price: 0,
          status: "invalid",
          reason: phoneResult.error || "Invalid phone number",
        })
        return
      }

      const normalizedPhone = phoneResult.normalized

      const volumeNum = parseFloat(volume)

      // Validate volume is a number
      if (isNaN(volumeNum) || volumeNum <= 0) {
        invalid++
        orders.push({
          id,
          phone,
          volume: 0,
          price: 0,
          status: "invalid",
          reason: "Volume must be a positive number",
        })
        return
      }

      // Check if volume matches available packages for selected network
      const matchingPackage = availablePackages.find(pkg => pkg.size === volumeNum)

      if (!matchingPackage) {
        invalid++
        orders.push({
          id,
          phone,
          volume: volumeNum,
          price: 0,
          status: "invalid",
          reason: `${selectedNetworkLabel} does not offer ${volumeNum}GB packages. Available: ${availableVolumes.join("GB, ")}GB`,
        })
        return
      }

      valid++
      orders.push({
        id,
        phone: normalizedPhone,
        volume: volumeNum,
        price: matchingPackage.price,
        status: "valid",
        reason: "Ready to process",
      })
    })

    return {
      total: lines.filter(l => l.trim()).length,
      valid,
      invalid,
      orders,
    }
  }

  // Live-verifies a batch of MTN phone numbers, chunked to this endpoint's
  // real 100-per-request limit. Failures default a phone to "verified" (the
  // same fail-open the endpoint itself uses) so a flaky check never blocks
  // an otherwise-valid order.
  const verifyPhonesLive = async (phones: string[]): Promise<Map<string, boolean>> => {
    const CHUNK_SIZE = 100
    const verifiedMap = new Map<string, boolean>()
    for (let i = 0; i < phones.length; i += CHUNK_SIZE) {
      const chunk = phones.slice(i, i + CHUNK_SIZE)
      try {
        const res = await fetch("/api/verify-phone-live", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ phones: chunk }),
        })
        if (res.ok) {
          const data = await res.json()
          const chunkResults: Array<{ phone: string; verified: boolean }> = data.results ?? []
          chunkResults.forEach(r => verifiedMap.set(r.phone, r.verified))
        }
      } catch (err) {
        console.warn("[BULK-ORDERS] Live verification check failed for a chunk, leaving unverified entries as verified:", err)
      }
    }
    return verifiedMap
  }

  const handleValidate = async () => {
    if (!selectedNetwork) {
      toast.error("Please select a network")
      return
    }

    if (!textInput.trim()) {
      toast.error("Please enter phone numbers and volumes")
      return
    }

    setIsValidating(true)
    try {
      const results = parseAndValidate(textInput)
      const selectedNetworkLabel = networks.find(n => n.id === selectedNetwork)?.label
      const validOrders = results.orders.filter(o => o.status === "valid")

      // Verified at validate time (not submit time) so "Place order" can go
      // straight through and only interrupt with a warning when it actually
      // needs to.
      if (selectedNetworkLabel?.toUpperCase() === "MTN" && validOrders.length > 0) {
        const verifiedMap = await verifyPhonesLive(validOrders.map(o => o.phone))
        results.orders = results.orders.map(o =>
          o.status === "valid" ? { ...o, verified: verifiedMap.get(o.phone) ?? true } : o
        )
      }

      setValidationResults(results)

      const unverifiedCount = results.orders.filter(o => o.status === "valid" && o.verified === false).length
      if (results.invalid > 0) {
        toast.warning(`Validation complete. ${results.valid} valid, ${results.invalid} invalid`)
      } else if (unverifiedCount > 0) {
        toast.warning(`${unverifiedCount} number(s) not yet verified`)
      } else {
        toast.success(`Validation successful! ${results.valid} valid orders ready to place`)
      }
    } catch (error) {
      toast.error("Validation failed")
    } finally {
      setIsValidating(false)
    }
  }

  const handleExcelDownload = () => {
    // Create a sample CSV template
    const template = "Phone Number,Volume (GB)\n0551053716,1\n0551053717,2\n0551053718,1"
    const element = document.createElement("a")
    element.setAttribute("href", "data:text/csv;charset=utf-8," + encodeURIComponent(template))
    element.setAttribute("download", "bulk_orders_template.csv")
    element.style.display = "none"
    document.body.appendChild(element)
    element.click()
    document.body.removeChild(element)
    toast.success("Template downloaded")
  }

  const parseXLSXBasic = (data: ArrayBuffer): string[][] => {
    // Basic XLSX parsing - finds XML content and extracts cell values
    const view = new Uint8Array(data)
    const text = new TextDecoder().decode(view)

    // Look for shared strings XML and worksheet XML
    const sharedStringsMatch = text.match(/<si>[\s\S]*?<\/si>/g) || []
    const strings: string[] = []

    sharedStringsMatch.forEach(match => {
      const textMatch = match.match(/<t[^>]*>([^<]*)<\/t>/)
      if (textMatch) {
        strings.push(textMatch[1])
      }
    })

    // Extract cells from worksheet
    const cellMatches = text.match(/<c[^>]*>[\s\S]*?<\/c>/g) || []
    const rows: Map<number, Map<number, string>> = new Map()

    cellMatches.forEach(cellMatch => {
      const refMatch = cellMatch.match(/r="([A-Z]+)(\d+)"/)
      if (!refMatch) return

      const col = refMatch[1].charCodeAt(0) - 65 // Convert A=0, B=1, etc
      const row = parseInt(refMatch[2]) - 1

      let value = ''
      const typeMatch = cellMatch.match(/t="([^"]*)"/)
      const vMatch = cellMatch.match(/<v>([^<]*)<\/v>/)

      if (typeMatch?.[1] === 's' && vMatch) {
        // String reference
        const idx = parseInt(vMatch[1])
        value = strings[idx] || ''
      } else if (vMatch) {
        // Numeric or direct value
        value = vMatch[1]
      }

      if (!rows.has(row)) rows.set(row, new Map())
      rows.get(row)!.set(col, value)
    })

    // Convert to 2D array
    const result: string[][] = []
    for (let i = 0; i < rows.size; i++) {
      const row = rows.get(i) || new Map()
      const rowData: string[] = []
      for (let j = 0; j < (row.size || 2); j++) {
        rowData.push(row.get(j) || '')
      }
      result.push(rowData)
    }

    return result
  }

  const handleExcelFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return

    if (!selectedNetwork) {
      toast.error("Please select a network first")
      return
    }

    try {
      let lines: string[] = []

      if (file.name.endsWith('.csv')) {
        // Handle CSV
        const text = await file.text()
        lines = text.split('\n').filter(line => line.trim())
      } else if (file.name.endsWith('.xlsx')) {
        // Handle XLSX
        const buffer = await file.arrayBuffer()
        const rows = parseXLSXBasic(buffer)

        // Convert 2D array to lines with comma-separated values
        lines = rows
          .map(row => row.join(','))
          .filter(line => line.trim())
      } else {
        toast.error("Please upload a CSV or XLSX file")
        return
      }

      // Skip header if it exists
      let dataLines = lines
      if (lines[0]?.toLowerCase().includes('phone') || lines[0]?.toLowerCase().includes('volume')) {
        dataLines = lines.slice(1)
      }

      // Convert to text format (phone volume per line)
      const formattedText = dataLines
        .map(line => {
          const parts = line.split(',').map(p => p.trim())
          if (parts.length >= 2) {
            return `${parts[0]} ${parts[1]}`
          }
          return line
        })
        .join('\n')

      setTextInput(formattedText)
      setActiveTab("text")
      toast.success("File uploaded and converted to text format")

      // Reset file input
      if (excelFileInput.current) {
        excelFileInput.current.value = ''
      }
    } catch (error) {
      console.error("Error parsing file:", error)
      toast.error("Failed to parse file. Please ensure it's a valid CSV or XLSX file.")
    }
  }

  const submitBulkOrders = async (ordersToSubmit: ValidationResult["orders"], networkLabel: string) => {
    setIsSubmitting(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token || !session.user?.id) {
        throw new Error("Not authenticated")
      }

      const response = await fetch("/api/orders/create-bulk", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          orders: ordersToSubmit.map(o => ({
            phone_number: o.phone,
            volume_gb: o.volume,
            price: o.price,
          })),
          network: networkLabel,
        }),
      })

      const data = await response.json()
      if (!response.ok) {
        throw new Error(data.error || "Failed to submit orders")
      }

      toast.success(`Successfully created ${data.count} orders!`)
      setBatchVerifyWarning(null)
      setValidationResults(null)
      setTextInput("")
      setSelectedNetwork("")
      setWalletBalance(null)

      console.log("Orders created:", data.orders)
    } catch (error) {
      console.error("Error submitting orders:", error)
      toast.error(error instanceof Error ? error.message : "Failed to submit orders")
    } finally {
      setIsSubmitting(false)
    }
  }

  // Goes straight to submission -- verification already happened at
  // validate time (see handleValidate), so this only interrupts with the
  // batch-verify warning modal when something actually needs it, instead of
  // always re-checking live before every submit.
  const handlePlaceOrder = async () => {
    if (!validationResults || validationResults.invalid > 0) {
      toast.error("Please fix validation errors before submitting")
      return
    }

    const validOrders = validationResults.orders.filter(o => o.status === "valid")
    if (validOrders.length === 0) {
      toast.error("No valid orders to submit")
      return
    }

    const selectedNetworkLabel = networks.find(n => n.id === selectedNetwork)?.label
    if (!selectedNetworkLabel) {
      toast.error("Invalid network selected")
      return
    }

    setIsSubmitting(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token || !session.user?.id) {
        throw new Error("Not authenticated")
      }

      // Re-check the balance fresh right before placing, rather than trusting
      // whatever was last fetched on mount.
      const { data: walletData, error: walletError } = await supabase
        .from("wallets")
        .select("balance")
        .eq("user_id", session.user.id)

      if (walletError && walletError.code !== "PGRST116") {
        throw new Error("Failed to fetch wallet balance")
      }

      const wallet = walletData && walletData.length > 0 ? walletData[0] : null
      const availableBalance = wallet?.balance || 0
      setWalletBalance(availableBalance)

      const totalCost = validOrders.reduce((sum, order) => sum + order.price, 0)
      if (availableBalance < totalCost) {
        toast.error(`Insufficient wallet balance. Required: GHS ${totalCost.toFixed(2)}, Available: GHS ${availableBalance.toFixed(2)}`)
        return
      }

      const unverifiedPhones = validOrders.filter(o => o.verified === false).map(o => o.phone)
      if (unverifiedPhones.length > 0) {
        setBatchVerifyWarning({ unverifiedPhones, ordersToSubmit: validOrders, networkLabel: selectedNetworkLabel })
        return
      }

      await submitBulkOrders(validOrders, selectedNetworkLabel)
    } catch (error) {
      console.error("Error placing bulk order:", error)
      toast.error(error instanceof Error ? error.message : "Failed to place order")
    } finally {
      setIsSubmitting(false)
    }
  }

  const validOrders = validationResults?.orders.filter(o => o.status === "valid") ?? []
  const unverifiedOrders = validOrders.filter(o => o.verified === false)
  const totalCost = validOrders.reduce((sum, o) => sum + o.price, 0)

  return (
    <Card className="bg-card backdrop-blur-xl border border-[#1b388b]/20 hover:border-border hover:shadow-2xl transition-all duration-300">
      <CardHeader>
        <div className="flex items-center gap-2">
          <Download className="h-5 w-5 text-[#1b388b]" />
          <div>
            <CardTitle className="text-foreground">Bulk Orders (Excel/Text)</CardTitle>
            <CardDescription>Upload multiple phone numbers at once</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Network Selection -- hidden when an external picker (the network
            cards on the data-packages page) already drives this. */}
        {presetNetwork ? (
          <p className="text-sm text-muted-foreground">
            Network: <span className="font-semibold text-foreground">{presetNetwork}</span>
          </p>
        ) : (
          <div className="space-y-2">
            <Label htmlFor="network">Select Network</Label>
            <Select value={selectedNetwork} onValueChange={setSelectedNetwork} disabled={loading}>
              <SelectTrigger id="network">
                <SelectValue placeholder={loading ? "Loading networks..." : "Choose network"} />
              </SelectTrigger>
              <SelectContent>
                {networks.map((network) => (
                  <SelectItem key={network.id} value={network.id}>
                    {network.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {/* Tabs -- underline style */}
        <div className="flex border-b border-border">
          <button
            onClick={() => setActiveTab("text")}
            className={`flex items-center gap-2 border-b-2 px-4 py-2.5 text-sm font-semibold transition ${
              activeTab === "text" ? "border-foreground text-foreground" : "border-transparent text-muted-foreground"
            }`}
          >
            Text
          </button>
          <button
            onClick={() => setActiveTab("excel")}
            className={`flex items-center gap-2 border-b-2 px-4 py-2.5 text-sm font-semibold transition ${
              activeTab === "excel" ? "border-foreground text-foreground" : "border-transparent text-muted-foreground"
            }`}
          >
            Excel / CSV
          </button>
        </div>

        {/* Text Input Tab */}
        {activeTab === "text" && (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">
              One per line · up to 500 items · e.g. <span className="font-mono font-semibold text-foreground">0241234567 5</span> or <span className="font-mono font-semibold text-foreground">0551234567 10</span>
            </p>
            <div className="relative">
              <Textarea
                id="text-input"
                placeholder={"0241234567 5\n0551234567 10"}
                value={textInput}
                onChange={(e) => setTextInput(e.target.value)}
                rows={6}
                className="font-mono text-sm bg-card/70 backdrop-blur border-border focus:border-[#1b388b] focus:ring-2 focus:ring-[#1b388b]/50"
              />
              <button
                type="button"
                aria-label="Reload package prices"
                onClick={loadPackages}
                disabled={loading}
                className="absolute bottom-3 right-3 flex h-11 w-11 items-center justify-center rounded-full bg-card text-foreground  border border-white/60 dark:border-white/5 disabled:opacity-50 clay-sm"
              >
                <span className={loading ? "animate-spin" : ""}>↻</span>
              </button>
            </div>
          </div>
        )}

        {/* Excel Upload Tab */}
        {activeTab === "excel" && (
          <div className="space-y-4">
            <div className="border-2 border-dashed border-border rounded-lg p-6 text-center hover:border-[#1b388b] transition-colors cursor-pointer">
              <p className="text-muted-foreground mb-2">Click to upload Excel file or drag and drop</p>
              <p className="text-xs text-muted-foreground">CSV or XLSX files only</p>
              <Input
                type="file"
                accept=".csv,.xlsx"
                className="mt-4"
                ref={excelFileInput}
                onChange={handleExcelFileUpload}
              />
            </div>
            <Button
              variant="outline"
              onClick={handleExcelDownload}
              className="w-full"
            >
              Download Template
            </Button>
          </div>
        )}

        {/* Validate Button */}
        <Button
          onClick={handleValidate}
          disabled={isValidating || !selectedNetwork || loading}
          variant="outline"
          className="w-full font-semibold"
        >
          {loading ? "Loading..." : isValidating ? "Validating..." : "Validate"}
        </Button>

        {/* Validation Results -- compact list, not a table. Keeps the
            invalid-row reason (why it failed) even though the reference's
            compact style doesn't show one. Summary (total cost, wallet
            balance, unverified count) folded into this header instead of a
            separate preview step. */}
        {validationResults && (
          <div className="space-y-3">
            <div className="space-y-2 rounded-2xl border border-white/60 dark:border-white/5 bg-card p-3 clay">
              <div className="flex items-center justify-between">
                <p className="text-sm font-bold">
                  <span className="text-success">{validationResults.valid} valid</span>
                  {validationResults.invalid > 0 && (
                    <span className="text-destructive"> · {validationResults.invalid} invalid</span>
                  )}
                  {unverifiedOrders.length > 0 && (
                    <span className="text-warning"> · {unverifiedOrders.length} unverified</span>
                  )}
                </p>
                <button
                  type="button"
                  onClick={() => { setValidationResults(null); setTextInput("") }}
                  className="text-xs font-semibold text-destructive hover:underline"
                >
                  Clear all
                </button>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-2">
                <p className="text-xs text-muted-foreground">
                  Total: <span className="font-bold text-foreground">GHS {totalCost.toFixed(2)}</span>
                  {" · "}Wallet: <span className="font-bold text-foreground">GHS {(walletBalance ?? 0).toFixed(2)}</span>
                </p>
                <div className="flex items-center gap-3 text-xs font-semibold">
                  {validationResults.invalid > 0 && (
                    <button
                      type="button"
                      onClick={() => {
                        const kept = validationResults.orders.filter(o => o.status === "valid")
                        setValidationResults({ ...validationResults, orders: kept, invalid: 0 })
                        setTextInput(kept.map(o => `${o.phone} ${o.volume}`).join("\n"))
                      }}
                      className="text-warning hover:underline"
                    >
                      Clear invalid
                    </button>
                  )}
                  {unverifiedOrders.length > 0 && (
                    <button
                      type="button"
                      onClick={() => {
                        // "Exports" the remaining rows back into the textarea,
                        // same pattern as Clear invalid.
                        const kept = validationResults.orders.filter(o => !(o.status === "valid" && o.verified === false))
                        const keptValidCount = kept.filter(o => o.status === "valid").length
                        setValidationResults({ ...validationResults, orders: kept, valid: keptValidCount })
                        setTextInput(kept.filter(o => o.status === "valid").map(o => `${o.phone} ${o.volume}`).join("\n"))
                      }}
                      className="text-warning hover:underline"
                    >
                      Clear unverified
                    </button>
                  )}
                </div>
              </div>
            </div>

            <div className="max-h-80 space-y-1 overflow-y-auto rounded-2xl border border-white/60 dark:border-white/5 bg-card p-2 clay">
              {validationResults.orders.map((order) => {
                const isUnverified = order.status === "valid" && order.verified === false
                return (
                  <div
                    key={order.id}
                    className={`flex items-center gap-3 rounded-xl px-2 py-2 ${order.status === "invalid" ? "bg-destructive/5" : isUnverified ? "bg-warning/5" : ""}`}
                  >
                    <span className={`h-2 w-2 shrink-0 rounded-full ${order.status === "invalid" ? "bg-destructive" : isUnverified ? "bg-warning" : "bg-success"}`} />
                    <span className="min-w-0 flex-1 truncate font-mono text-sm">{order.phone}</span>
                    {order.status === "valid" ? (
                      <>
                        {isUnverified && <span className="shrink-0 text-[10px] font-bold uppercase text-warning">Unverified</span>}
                        <span className="shrink-0 text-sm text-muted-foreground">{order.volume}GB</span>
                        <span className="shrink-0 text-sm font-bold">GHS{order.price.toFixed(2)}</span>
                      </>
                    ) : (
                      <span className="shrink-0 max-w-[55%] truncate text-xs text-destructive" title={order.reason}>{order.reason}</span>
                    )}
                  </div>
                )
              })}
            </div>

            <div className="flex items-center justify-between gap-2 rounded-2xl border border-white/60 dark:border-white/5 bg-card p-3 clay">
              <p className="text-xs text-muted-foreground">{validationResults.valid} valid rows</p>
              <Button
                onClick={handlePlaceOrder}
                disabled={isSubmitting || validationResults.invalid > 0 || validOrders.length === 0}
                className="bg-[#1b388b] text-primary-foreground hover:bg-[#1b388b]/90"
              >
                {isSubmitting ? "Placing order..." : "Place order"}
              </Button>
            </div>
          </div>
        )}

        {/* Batch Verification Warning Dialog -- the only interrupt "Place
            order" ever shows; everything else (totals, balance) is already
            visible in the results header above, so there's no separate
            preview step. */}
        <Dialog open={!!batchVerifyWarning} onOpenChange={(open) => { if (!open) setBatchVerifyWarning(null) }}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{batchVerifyWarning?.unverifiedPhones.length} number(s) not yet verified</DialogTitle>
              <DialogDescription>
                The following numbers haven&apos;t been verified yet: {[...new Set(batchVerifyWarning?.unverifiedPhones ?? [])].join(", ")}.
                Orders for these may be delayed until they clear — they&apos;ll still be delivered automatically once verified.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter className="flex-col sm:flex-row gap-2">
              <Button variant="outline" onClick={() => setBatchVerifyWarning(null)} disabled={isSubmitting}>
                Cancel
              </Button>
              <Button
                variant="outline"
                disabled={
                  isSubmitting ||
                  !batchVerifyWarning ||
                  batchVerifyWarning.ordersToSubmit.filter(o => !batchVerifyWarning.unverifiedPhones.includes(o.phone)).length === 0
                }
                onClick={() => {
                  if (!batchVerifyWarning) return
                  const filtered = batchVerifyWarning.ordersToSubmit.filter(
                    o => !batchVerifyWarning.unverifiedPhones.includes(o.phone)
                  )
                  submitBulkOrders(filtered, batchVerifyWarning.networkLabel)
                }}
              >
                {isSubmitting ? "Processing..." : "Remove unverified & submit rest"}
              </Button>
              <Button
                disabled={isSubmitting || !batchVerifyWarning}
                onClick={() => {
                  if (!batchVerifyWarning) return
                  submitBulkOrders(batchVerifyWarning.ordersToSubmit, batchVerifyWarning.networkLabel)
                }}
              >
                {isSubmitting ? "Processing..." : "Proceed with all"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  )
}
