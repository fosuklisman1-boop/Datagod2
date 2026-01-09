"use client"

import { useState, useEffect } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { AlertCircle, Trash2, Upload, Plus, ChevronLeft, ChevronRight } from "lucide-react"
import { toast } from "sonner"
import { supabase } from "@/lib/supabase"

interface BlacklistedNumber {
  id: string
  phone_number: string
  reason?: string
  created_at: string
}

export default function PhoneBlacklistManager() {
  const [blacklist, setBlacklist] = useState<BlacklistedNumber[]>([])
  const [loading, setLoading] = useState(false)
  const [newPhone, setNewPhone] = useState("")
  const [newReason, setNewReason] = useState("")
  const [searching, setSearching] = useState(false)
  const [searchQuery, setSearchQuery] = useState("")
  const [authToken, setAuthToken] = useState<string | null>(null)
  const [currentPage, setCurrentPage] = useState(1)
  const itemsPerPage = 10

  // Get auth token on mount
  useEffect(() => {
    const getAuthToken = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (session?.access_token) {
        setAuthToken(session.access_token)
      }
    }
    getAuthToken()
  }, [])

  const getHeaders = () => {
    const headers: any = { "Content-Type": "application/json" }
    if (authToken) {
      headers.Authorization = `Bearer ${authToken}`
    }
    return headers
  }

  const loadBlacklist = async (query = "") => {
    try {
      setLoading(true)
      setCurrentPage(1) // Reset to first page on new search
      const response = await fetch(`/api/admin/blacklist?search=${encodeURIComponent(query)}`, {
        headers: getHeaders(),
      })
      const data = await response.json()
      setBlacklist(data.data || [])
    } catch (error) {
      console.error("Error loading blacklist:", error)
      toast.error("Failed to load blacklist")
    } finally {
      setLoading(false)
    }
  }

  const addSingleNumber = async () => {
    if (!newPhone.trim()) {
      toast.error("Please enter a phone number")
      return
    }

    try {
      const response = await fetch("/api/admin/blacklist", {
        method: "POST",
        headers: getHeaders(),
        body: JSON.stringify({
          phone_number: newPhone.trim(),
          reason: newReason || null,
        }),
      })

      const data = await response.json()

      if (data.success) {
        toast.success(`Added ${newPhone} to blacklist`)
        setNewPhone("")
        setNewReason("")
        loadBlacklist()
      } else {
        toast.error(data.error || "Failed to add to blacklist")
      }
    } catch (error) {
      console.error("Error:", error)
      toast.error("Failed to add to blacklist")
    }
  }

  const removeNumber = async (phone: string) => {
    try {
      const response = await fetch(`/api/admin/blacklist?phone=${encodeURIComponent(phone)}`, {
        method: "DELETE",
        headers: getHeaders(),
      })

      const data = await response.json()

      if (data.success) {
        toast.success(`Removed ${phone} from blacklist`)
        loadBlacklist()
      } else {
        toast.error(data.error || "Failed to remove from blacklist")
      }
    } catch (error) {
      console.error("Error:", error)
      toast.error("Failed to remove from blacklist")
    }
  }

  const handleBulkImport = async (phones: string[]) => {
    try {
      const response = await fetch("/api/admin/blacklist/bulk", {
        method: "POST",
        headers: getHeaders(),
        body: JSON.stringify({
          phones: phones.filter(p => p.trim()),
          reason: "Bulk import",
        }),
      })

      const data = await response.json()

      if (data.success) {
        toast.success(`Imported ${data.imported} phone numbers`)
        loadBlacklist()
      } else {
        toast.error(data.error || "Failed to bulk import")
      }
    } catch (error) {
      console.error("Error:", error)
      toast.error("Failed to bulk import")
    }
  }

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    const reader = new FileReader()
    reader.onload = (event) => {
      try {
        const text = event.target?.result as string
        // Support CSV or newline-separated
        const phones = text
          .split(/[\n,]+/)
          .map(p => p.trim())
          .filter(p => p.length > 0)

        if (phones.length === 0) {
          toast.error("No valid phone numbers found in file")
          return
        }

        handleBulkImport(phones)
      } catch (error) {
        console.error("Error parsing file:", error)
        toast.error("Failed to parse file")
      }
    }
    reader.readAsText(file)
  }

  return (
    <div className="space-y-6">
      {/* Add Single Number */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <AlertCircle className="w-5 h-5" />
            Add Phone to Blacklist
          </CardTitle>
          <CardDescription>
            Block a single phone number from receiving automatic fulfillment
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Input
              placeholder="Phone number (e.g., 0550459364)"
              value={newPhone}
              onChange={(e) => setNewPhone(e.target.value)}
            />
            <Input
              placeholder="Reason (optional)"
              value={newReason}
              onChange={(e) => setNewReason(e.target.value)}
            />
            <Button onClick={addSingleNumber} className="gap-2">
              <Plus className="w-4 h-4" />
              Add
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Bulk Import */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Upload className="w-5 h-5" />
            Bulk Import
          </CardTitle>
          <CardDescription>
            Upload a CSV or text file with phone numbers (one per line or comma-separated)
          </CardDescription>
        </CardHeader>
        <CardContent>
          <input
            type="file"
            accept=".csv,.txt"
            onChange={handleFileUpload}
            className="block w-full text-sm"
          />
        </CardContent>
      </Card>

      {/* Blacklist Table */}
      <Card>
        <CardHeader>
          <CardTitle>Blacklisted Numbers</CardTitle>
          <CardDescription>
            {blacklist.length} phone numbers on blacklist
          </CardDescription>
          <Input
            placeholder="Search phone number..."
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value)
              loadBlacklist(e.target.value)
            }}
            className="mt-4"
          />
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="text-center py-8 text-muted-foreground">Loading...</div>
          ) : blacklist.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              No blacklisted numbers yet
            </div>
          ) : (
            <div className="space-y-4">
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Phone Number</TableHead>
                      <TableHead>Reason</TableHead>
                      <TableHead>Added</TableHead>
                      <TableHead>Action</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(() => {
                      const startIndex = (currentPage - 1) * itemsPerPage
                      const endIndex = startIndex + itemsPerPage
                      const paginatedBlacklist = blacklist.slice(startIndex, endIndex)
                      return paginatedBlacklist.map((entry) => (
                        <TableRow key={entry.id}>
                          <TableCell className="font-mono">{entry.phone_number}</TableCell>
                          <TableCell>{entry.reason || "-"}</TableCell>
                          <TableCell className="text-sm text-muted-foreground">
                            {new Date(entry.created_at).toLocaleDateString()}
                          </TableCell>
                          <TableCell>
                            <Button
                              size="sm"
                              variant="destructive"
                              onClick={() => removeNumber(entry.phone_number)}
                              className="gap-1 bg-black text-white hover:bg-gray-800"
                            >
                              <Trash2 className="w-3 h-3" />
                              Remove
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))
                    })()}
                  </TableBody>
                </Table>
              </div>

              {/* Pagination Controls */}
              {blacklist.length > itemsPerPage && (
                <div className="flex items-center justify-between pt-4 border-t">
                  <div className="text-sm text-muted-foreground">
                    Showing {(currentPage - 1) * itemsPerPage + 1} to {Math.min(currentPage * itemsPerPage, blacklist.length)} of {blacklist.length}
                  </div>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                      disabled={currentPage === 1}
                      className="gap-1"
                    >
                      <ChevronLeft className="w-4 h-4" />
                      Previous
                    </Button>
                    <div className="flex items-center gap-1">
                      {Array.from({ length: Math.ceil(blacklist.length / itemsPerPage) }, (_, i) => i + 1).map(
                        (page) => (
                          <Button
                            key={page}
                            variant={currentPage === page ? "default" : "outline"}
                            size="sm"
                            onClick={() => setCurrentPage(page)}
                            className="w-8 h-8 p-0"
                          >
                            {page}
                          </Button>
                        )
                      )}
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setCurrentPage(p => Math.min(Math.ceil(blacklist.length / itemsPerPage), p + 1))}
                      disabled={currentPage >= Math.ceil(blacklist.length / itemsPerPage)}
                      className="gap-1"
                    >
                      Next
                      <ChevronRight className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
              )}
            </div>
        </CardContent>
      </Card>
    </div>
  )
}
