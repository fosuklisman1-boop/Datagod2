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
  }>
}

export function BulkOrdersForm() {
  const [activeTab, setActiveTab] = useState<"excel" | "text">("text")
  const [selectedNetwork, setSelectedNetwork] = useState("")
  const [textInput, setTextInput] = useState("")
  const [isValidating, setIsValidating] = useState(false)
  const [validationResults, setValidationResults] = useState<ValidationResult | null>(null)
  const [packages, setPackages] = useState<Array<{ network: string; size: number; price: number }>>([])
  const [networks, setNetworks] = useState<Array<{ id: string; label: string }>>([])
  const [loading, setLoading] = useState(true)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [showSummary, setShowSummary] = useState(false)
  const [walletBalance, setWalletBalance] = useState<number | null>(null)
  const excelFileInput = useRef<HTMLInputElement | null>(null)

  // Load packages from database on mount
  useEffect(() => {
    loadPackages()
  }, [])

  const loadPackages = async () => {
    try {
      const { data, error } = await supabase
        .from("packages")
        .select("*")
        .eq("active", true)
        .order("network", { ascending: true })
        .order("size", { ascending: true })

      if (error) throw error

      if (data) {
        // Transform data to match our format
        const transformedPackages = data.map((pkg: any) => ({
          network: pkg.network,
          size: parseFloat(pkg.size),
          price: pkg.price,
        }))

        setPackages(transformedPackages)

        // Extract unique networks and create network list
        const uniqueNetworks = [...new Set(data.map((pkg: any) => pkg.network))]
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
      toast.error("Failed to load packages from database")
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
      // Parse and validate
      await new Promise(resolve => setTimeout(resolve, 500))
      const results = parseAndValidate(textInput)
      setValidationResults(results)

      if (results.invalid === 0) {
        toast.success(`Validation successful! ${results.valid} valid orders ready to place`)
      } else {
        toast.warning(`Validation complete. ${results.valid} valid, ${results.invalid} invalid`)
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

  const handleSubmitOrders = async () => {
    if (!validationResults || validationResults.invalid > 0) {
      toast.error("Please fix validation errors before submitting")
      return
    }

    const validOrders = validationResults.orders.filter(o => o.status === "valid")
    if (validOrders.length === 0) {
      toast.error("No valid orders to submit")
      return
    }

    try {
      console.log("Preparing order submission...")
      
      // Get auth token and user
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token || !session.user?.id) {
        throw new Error("Not authenticated")
      }

      console.log("Fetching wallet balance for user:", session.user.id)
      
      // Check wallet balance
      const { data: walletData, error: walletError } = await supabase
        .from("wallets")
        .select("balance")
        .eq("user_id", session.user.id)

      if (walletError && walletError.code !== "PGRST116") {
        console.error("Wallet error:", walletError)
        throw new Error("Failed to fetch wallet balance")
      }

      const wallet = walletData && walletData.length > 0 ? walletData[0] : null
      const availableBalance = wallet?.balance || 0

      console.log("Wallet balance found:", availableBalance)
      
      // Calculate total cost
      const totalCost = validOrders.reduce((sum, order) => sum + order.price, 0)

      console.log("Total cost:", totalCost)
      
      // Check if balance is sufficient
      if (availableBalance < totalCost) {
        toast.error(
          `Insufficient wallet balance. Required: ₵${totalCost.toFixed(2)}, Available: ₵${availableBalance.toFixed(2)}`
        )
        return
      }

      console.log("Balance sufficient. Showing summary...")
      
      // Set wallet balance and show summary
      setWalletBalance(availableBalance)
      setShowSummary(true)
      console.log("Summary should be visible now")
    } catch (error) {
      console.error("Error preparing summary:", error)
      toast.error(error instanceof Error ? error.message : "Failed to prepare summary")
    }
  }

  const handleConfirmSubmission = async () => {
    if (!validationResults) return

    const validOrders = validationResults.orders.filter(o => o.status === "valid")
    setIsSubmitting(true)
    try {
      // Get the selected network label
      const selectedNetworkLabel = networks.find(n => n.id === selectedNetwork)?.label
      if (!selectedNetworkLabel) {
        throw new Error("Invalid network selected")
      }

      // Get auth token and user
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token || !session.user?.id) {
        throw new Error("Not authenticated")
      }

      // Call the bulk create API
      const response = await fetch("/api/orders/create-bulk", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          orders: validOrders.map(o => ({
            phone_number: o.phone,
            volume_gb: o.volume,
            price: o.price,
          })),
          network: selectedNetworkLabel,
        }),
      })

      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.error || "Failed to submit orders")
      }

      toast.success(`Successfully created ${data.count} orders!`)
      
      // Close summary dialog
      setShowSummary(false)
      
      // Reset form
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

  return (
    <Card className="bg-gradient-to-br from-blue-50/60 to-indigo-50/40 backdrop-blur-xl border border-blue-200/40 hover:border-blue-300/60 hover:shadow-2xl transition-all duration-300">
      <CardHeader>
        <div className="flex items-center gap-2">
          <Download className="h-5 w-5 text-violet-600" />
          <div>
            <CardTitle className="text-gray-900">Bulk Orders (Excel/Text)</CardTitle>
            <CardDescription>Upload multiple phone numbers at once</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Network Selection */}
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

        {/* Tab Buttons */}
        <div className="flex gap-2">
          <Button
            variant={activeTab === "text" ? "default" : "outline"}
            onClick={() => setActiveTab("text")}
            className={activeTab === "text" ? "bg-gradient-to-r from-violet-600 to-purple-600 text-white" : "hover:border-violet-400 hover:text-violet-700 bg-violet-50/30 border-violet-300/40 text-gray-700"}
          >
            Text Input
          </Button>
          <Button
            variant={activeTab === "excel" ? "default" : "outline"}
            onClick={() => setActiveTab("excel")}
            className={activeTab === "excel" ? "bg-gradient-to-r from-violet-600 to-purple-600 text-white" : "hover:border-violet-400 hover:text-violet-700 bg-violet-50/30 border-violet-300/40 text-gray-700"}
          >
            Excel Upload
          </Button>
        </div>

        {/* Text Input Tab */}
        {activeTab === "text" && (
          <div className="space-y-2">
            <Label htmlFor="text-input">Paste numbers and volumes (e.g. 0551053716 1)</Label>
            <Textarea
              id="text-input"
              placeholder="One per line, e.g. 0551053716 1"
              value={textInput}
              onChange={(e) => setTextInput(e.target.value)}
              rows={6}
              className="font-mono text-sm bg-white/70 backdrop-blur border-violet-300/50 focus:border-violet-400 focus:ring-2 focus:ring-violet-500/50"
            />
            <p className="text-xs text-gray-600">
              Format: Phone number followed by space and volume in GB
            </p>
          </div>
        )}

        {/* Excel Upload Tab */}
        {activeTab === "excel" && (
          <div className="space-y-4">
            <div className="border-2 border-dashed border-violet-300 rounded-lg p-6 text-center hover:border-violet-500 transition-colors cursor-pointer">
              <p className="text-gray-600 mb-2">Click to upload Excel file or drag and drop</p>
              <p className="text-xs text-gray-500">CSV or XLSX files only</p>
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
          className="w-full bg-gradient-to-r from-violet-600 via-purple-600 to-fuchsia-600 hover:from-violet-700 hover:via-purple-700 hover:to-fuchsia-700 shadow-lg hover:shadow-xl transition-all duration-300 text-white font-semibold"
        >
          {loading ? "Loading..." : isValidating ? "Validating..." : "Validate"}
        </Button>

        {/* Validation Results */}
        {validationResults && (
          <div className="space-y-4 border-t pt-4">
            {/* Header with Clear Buttons */}
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-semibold">Validation Results</h3>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    if (validationResults) {
                      // Keep only valid orders
                      const validOrders = validationResults.orders.filter(o => o.status === "valid")
                      setValidationResults({
                        ...validationResults,
                        orders: validOrders,
                        invalid: 0,
                      })
                      // Update text input to only show valid phone/volume pairs
                      const validLines = validOrders.map(o => `${o.phone} ${o.volume}`).join("\n")
                      setTextInput(validLines)
                    }
                  }}
                  className="text-amber-700 border-amber-300 hover:bg-amber-50"
                >
                  🗑️ Clear Invalid
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setValidationResults(null)
                    setTextInput("")
                  }}
                  className="text-rose-700 border-rose-300 hover:bg-rose-50"
                >
                  ✕ Clear All
                </Button>
              </div>
            </div>

            {/* Results Table */}
            <div className="overflow-x-auto border rounded-lg bg-gradient-to-br from-blue-50/60 to-indigo-50/40 backdrop-blur border-blue-200/40">
              <table className="w-full text-sm">
                <thead className="bg-gradient-to-r from-blue-100/60 via-indigo-100/60 to-violet-100/60 backdrop-blur border-b border-blue-200/40">
                  <tr>
                    <th className="px-4 py-2 text-left font-semibold text-gray-900">#</th>
                    <th className="px-4 py-2 text-left font-semibold text-gray-900">Phone Number</th>
                    <th className="px-4 py-2 text-left font-semibold text-gray-900">Volume (GB)</th>
                    <th className="px-4 py-2 text-left font-semibold text-gray-900">Package Price</th>
                    <th className="px-4 py-2 text-left font-semibold text-gray-900">Status</th>
                    <th className="px-4 py-2 text-left font-semibold text-gray-900">Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {validationResults.orders.map((order, idx) => (
                    <tr
                      key={idx}
                      className={order.status === "valid" ? "bg-emerald-50/40 hover:bg-emerald-100/40" : "bg-rose-50/40 hover:bg-rose-100/40"}
                    >
                      <td className="px-4 py-2">{order.id}</td>
                      <td
                        className={`px-4 py-2 ${
                          order.status === "invalid" ? "text-red-600" : ""
                        }`}
                      >
                        {order.phone}
                      </td>
                      <td className={`px-4 py-2 ${
                          order.status === "invalid" ? "text-red-600" : ""
                        }`}>
                        {order.volume > 0 ? `${order.volume} GB` : "N/A"}
                      </td>
                      <td className={`px-4 py-2 ${
                          order.status === "invalid" ? "text-red-600" : ""
                        }`}>
                        {order.price > 0 ? `GHS ${order.price.toFixed(2)}` : "N/A"}
                      </td>
                      <td className="px-4 py-2">
                        <span
                          className={`px-2 py-1 rounded text-xs font-semibold ${
                            order.status === "valid"
                              ? "bg-gradient-to-r from-emerald-100/80 to-teal-100/80 text-emerald-700 border border-emerald-200/60"
                              : "bg-gradient-to-r from-rose-100/80 to-pink-100/80 text-rose-700 border border-rose-200/60"
                          }`}
                        >
                          {order.status === "valid" ? "✓ Valid" : "✕ Invalid"}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-gray-600">{order.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Summary Statistics */}
            <div className="bg-gradient-to-br from-violet-50/60 to-purple-50/40 backdrop-blur-xl p-4 rounded-lg border border-violet-200/40">
              <div className="flex items-center justify-between">
                <div className="space-y-1">
                  <p className="text-sm text-gray-600">
                    Total: <span className="font-semibold">{validationResults.total}</span> |{" "}
                    <span className="text-emerald-600">
                      Valid: <span className="font-semibold">{validationResults.valid}</span>
                    </span>{" "}
                    |{" "}
                    <span className="text-rose-600">
                      Invalid: <span className="font-semibold">{validationResults.invalid}</span>
                    </span>
                  </p>
                  <p className="text-lg font-bold">
                    Total Cost:{" "}
                    <span className="bg-gradient-to-r from-violet-600 via-purple-600 to-fuchsia-600 bg-clip-text text-transparent">
                      GHS{" "}
                      {validationResults.orders
                        .filter((o) => o.status === "valid")
                        .reduce((sum, o) => sum + o.price, 0)
                        .toFixed(2)}
                    </span>
                  </p>
                </div>
                {validationResults.invalid === 0 && (
                  <Button 
                    onClick={handleSubmitOrders}
                    disabled={isSubmitting}
                    className="bg-gradient-to-r from-violet-600 via-purple-600 to-fuchsia-600 hover:from-violet-700 hover:via-purple-700 hover:to-fuchsia-700 px-6 shadow-lg hover:shadow-xl transition-all text-white font-semibold"
                  >
                    {isSubmitting ? "Submitting..." : "✓ SUBMIT ORDER"}
                  </Button>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Summary Dialog */}
        <Dialog open={showSummary} onOpenChange={setShowSummary}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>Order Summary</DialogTitle>
              <DialogDescription>
                Please review your order details before confirming submission
              </DialogDescription>
            </DialogHeader>
            
            {validationResults && (
              <div className="space-y-4 py-4">
                <div className="bg-blue-50 p-4 rounded-lg space-y-2">
                  <div className="flex justify-between">
                    <span className="text-sm text-gray-600">Number of Orders:</span>
                    <span className="font-semibold text-lg">{validationResults.valid}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-sm text-gray-600">Network:</span>
                    <span className="font-semibold">
                      {networks.find(n => n.id === selectedNetwork)?.label}
                    </span>
                  </div>
                  <div className="border-t pt-2 flex justify-between">
                    <span className="text-sm text-gray-600">Total Cost:</span>
                    <span className="font-bold text-lg text-violet-600">
                      ₵{validationResults.orders
                        .filter(o => o.status === "valid")
                        .reduce((sum, o) => sum + o.price, 0)
                        .toFixed(2)}
                    </span>
                  </div>
                </div>

                <div className="bg-green-50 p-4 rounded-lg">
                  <div className="flex justify-between">
                    <span className="text-sm text-gray-600">Available Balance:</span>
                    <span className="font-bold text-lg text-emerald-600">
                      ₵{walletBalance?.toFixed(2) || "0.00"}
                    </span>
                  </div>
                  <div className="flex justify-between mt-2">
                    <span className="text-sm text-gray-600">Balance After:</span>
                    <span className="font-bold text-lg text-emerald-600">
                      ₵{(
                        (walletBalance || 0) -
                        validationResults.orders.filter(o => o.status === "valid").reduce((sum, o) => sum + o.price, 0)
                      ).toFixed(2)}
                    </span>
                  </div>
                </div>
              </div>
            )}

            <DialogFooter className="gap-2">
              <Button
                variant="outline"
                onClick={() => setShowSummary(false)}
                disabled={isSubmitting}
              >
                Cancel
              </Button>
              <Button
                onClick={handleConfirmSubmission}
                disabled={isSubmitting}
                className="bg-gradient-to-r from-violet-600 to-purple-600"
              >
                {isSubmitting ? "Processing..." : "Confirm & Submit"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  )
}
