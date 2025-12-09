"use client"

import { useState, useEffect } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Loader2, AlertCircle } from "lucide-react"
import { supabase } from "@/lib/supabase"
import { toast } from "sonner"

export default function AFASettingsPage() {
  const [price, setPrice] = useState("50.00")
  const [description, setDescription] = useState("")
  const [loading, setLoading] = useState(false)
  const [fetching, setFetching] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetchCurrentPrice()
  }, [])

  const fetchCurrentPrice = async () => {
    try {
      setFetching(true)
      setError(null)
      const response = await fetch("/api/afa/price")
      if (!response.ok) throw new Error("Failed to fetch price")

      const data = await response.json()
      setPrice(data.price?.toString() || "50.00")
      setDescription(data.description || "")
    } catch (err) {
      console.error("Error fetching price:", err)
      setError("Failed to load current price")
    } finally {
      setFetching(false)
    }
  }

  const handleUpdatePrice = async (e: React.FormEvent) => {
    e.preventDefault()

    try {
      setLoading(true)
      setError(null)

      const numPrice = parseFloat(price)
      if (isNaN(numPrice) || numPrice <= 0) {
        setError("Price must be a valid positive number")
        return
      }

      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) {
        setError("Not authenticated")
        return
      }

      const response = await fetch("/api/afa/price", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          price: numPrice,
          description: description,
        }),
      })

      if (!response.ok) {
        const data = await response.json()
        throw new Error(data.error || "Failed to update price")
      }

      toast.success("AFA registration price updated successfully")
      await fetchCurrentPrice()
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Failed to update price"
      setError(errorMsg)
      toast.error(errorMsg)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">AFA Registration Settings</h1>
        <p className="text-gray-600 mt-2">Manage MTN AFA registration pricing</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Registration Price</CardTitle>
          <CardDescription>
            Set the price for MTN AFA registration. This will be charged from user wallets.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {error && (
            <Alert variant="destructive" className="mb-4">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {fetching ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-blue-600" />
            </div>
          ) : (
            <form onSubmit={handleUpdatePrice} className="space-y-4">
              <div>
                <Label htmlFor="price">Price (GHS)</Label>
                <div className="flex gap-2">
                  <Input
                    id="price"
                    type="number"
                    step="0.01"
                    min="0"
                    value={price}
                    onChange={(e) => setPrice(e.target.value)}
                    className="flex-1"
                    placeholder="Enter price"
                  />
                  <span className="flex items-center px-3 bg-gray-100 rounded-md font-semibold">
                    GHS
                  </span>
                </div>
              </div>

              <div>
                <Label htmlFor="description">Description</Label>
                <Input
                  id="description"
                  type="text"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Optional description"
                />
              </div>

              <Button
                type="submit"
                disabled={loading}
                className="w-full"
              >
                {loading ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Updating...
                  </>
                ) : (
                  "Update Price"
                )}
              </Button>
            </form>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Information</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p>
            <strong>Current Price:</strong> GHS {parseFloat(price).toFixed(2)}
          </p>
          <p>
            <strong>Currency:</strong> Ghanaian Cedis (GHS)
          </p>
          <p>
            <strong>Storage:</strong> Database (afa_registration_prices table)
          </p>
          <p className="text-gray-600">
            Changes to the price will take effect immediately for new registrations.
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
