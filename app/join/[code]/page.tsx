"use client"

import { useEffect, useState } from "react"
import { useParams, useRouter } from "next/navigation"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Loader2, Store, CheckCircle, AlertCircle, Eye, EyeOff } from "lucide-react"
import { toast } from "sonner"
import Link from "next/link"

interface InviteData {
  code: string
  expires_at: string
  shop_name: string
  shop_id: string
}

interface WholesalePackage {
  network: string
  size: number
  wholesale_price: number
}

export default function JoinPage() {
  const params = useParams()
  const router = useRouter()
  const code = params.code as string

  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  
  const [inviteData, setInviteData] = useState<InviteData | null>(null)
  const [wholesalePackages, setWholesalePackages] = useState<WholesalePackage[]>([])
  
  const [formData, setFormData] = useState({
    email: "",
    password: "",
    first_name: "",
    last_name: "",
    phone: "",
    shop_name: "",
    shop_slug: ""
  })

  useEffect(() => {
    fetchInviteDetails()
  }, [code])

  const fetchInviteDetails = async () => {
    try {
      setLoading(true)
      setError(null)

      const response = await fetch(`/api/shop/invites/${code}`)
      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.error || "Invalid invite")
      }

      setInviteData(data.invite)
      setWholesalePackages(data.wholesale_packages || [])
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load invite")
    } finally {
      setLoading(false)
    }
  }

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target
    setFormData(prev => ({ ...prev, [name]: value }))

    // Auto-generate slug from shop name with random suffix
    if (name === "shop_name") {
      const baseSlug = value
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, "")
        .replace(/\s+/g, "-")
        .replace(/-+/g, "-")
        .trim()
      // Add random 4-character suffix to prevent duplicates
      const randomSuffix = Math.random().toString(36).substring(2, 6)
      const slug = baseSlug ? `${baseSlug}-${randomSuffix}` : ""
      setFormData(prev => ({ ...prev, shop_slug: slug }))
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    
    if (!formData.email || !formData.password || !formData.shop_name || !formData.shop_slug) {
      toast.error("Please fill in all required fields")
      return
    }

    if (formData.password.length < 6) {
      toast.error("Password must be at least 6 characters")
      return
    }

    try {
      setSubmitting(true)

      const response = await fetch(`/api/shop/invites/${code}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(formData)
      })

      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.error || "Failed to create account")
      }

      setSuccess(true)
      toast.success("Account created successfully!")

      // Redirect to login with dashboard redirect after 2 seconds
      setTimeout(() => {
        router.push("/auth/login?redirect=/dashboard/my-shop")
      }, 2000)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create account")
    } finally {
      setSubmitting(false)
    }
  }

  const getNetworkColor = (network: string) => {
    const colors: { [key: string]: string } = {
      "MTN": "bg-yellow-100 text-yellow-800",
      "Telecel": "bg-red-100 text-red-800",
      "AT - iShare": "bg-blue-100 text-blue-800",
      "AT - BigTime": "bg-purple-100 text-purple-800",
    }
    return colors[network] || "bg-gray-100 text-gray-800"
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-blue-50 to-indigo-100">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-blue-50 to-indigo-100 p-4">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <AlertCircle className="w-12 h-12 text-red-500 mx-auto mb-4" />
            <CardTitle className="text-red-600">Invalid Invite</CardTitle>
            <CardDescription>{error}</CardDescription>
          </CardHeader>
          <CardContent className="text-center">
            <Link href="/">
              <Button variant="outline">Go to Homepage</Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    )
  }

  if (success) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-blue-50 to-indigo-100 p-4">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <CheckCircle className="w-12 h-12 text-green-500 mx-auto mb-4" />
            <CardTitle className="text-green-600">Account Created!</CardTitle>
            <CardDescription>
              Your sub-agent account has been created successfully. Redirecting to login...
            </CardDescription>
          </CardHeader>
          <CardContent className="text-center">
            <Loader2 className="w-6 h-6 animate-spin mx-auto text-blue-600" />
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 py-8 px-4">
      <div className="max-w-2xl mx-auto space-y-6">
        {/* Header */}
        <div className="text-center">
          <Store className="w-12 h-12 text-blue-600 mx-auto mb-4" />
          <h1 className="text-3xl font-bold text-gray-900">Join as Sub-Agent</h1>
          <p className="text-gray-600 mt-2">
            You&apos;ve been invited by <span className="font-semibold text-blue-600">{inviteData?.shop_name}</span>
          </p>
        </div>

        {/* What you get */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">What you&apos;ll get</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2 text-sm">
              <li className="flex items-center gap-2">
                <CheckCircle className="w-4 h-4 text-green-500" />
                Your own storefront to sell data
              </li>
              <li className="flex items-center gap-2">
                <CheckCircle className="w-4 h-4 text-green-500" />
                Buy data at wholesale prices
              </li>
              <li className="flex items-center gap-2">
                <CheckCircle className="w-4 h-4 text-green-500" />
                Set your own prices and keep the profit
              </li>
              <li className="flex items-center gap-2">
                <CheckCircle className="w-4 h-4 text-green-500" />
                Withdraw earnings to your mobile money
              </li>
            </ul>
          </CardContent>
        </Card>

        {/* Wholesale Prices */}
        {wholesalePackages.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Your Wholesale Prices</CardTitle>
              <CardDescription>These are your costs. Set higher prices to make profit.</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {wholesalePackages.slice(0, 6).map((pkg, idx) => (
                  <div key={idx} className="p-3 border rounded-lg text-center">
                    <Badge className={getNetworkColor(pkg.network)}>{pkg.network}</Badge>
                    <div className="font-semibold mt-1">{pkg.size}GB</div>
                    <div className="text-blue-600 font-bold">GHS {pkg.wholesale_price.toFixed(2)}</div>
                  </div>
                ))}
              </div>
              {wholesalePackages.length > 6 && (
                <p className="text-sm text-gray-500 mt-2 text-center">
                  + {wholesalePackages.length - 6} more packages
                </p>
              )}
            </CardContent>
          </Card>
        )}

        {/* Signup Form */}
        <Card>
          <CardHeader>
            <CardTitle>Create Your Account</CardTitle>
            <CardDescription>Fill in your details to get started</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="first_name">First Name</Label>
                  <Input
                    id="first_name"
                    name="first_name"
                    value={formData.first_name}
                    onChange={handleInputChange}
                    placeholder="John"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="last_name">Last Name</Label>
                  <Input
                    id="last_name"
                    name="last_name"
                    value={formData.last_name}
                    onChange={handleInputChange}
                    placeholder="Doe"
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="email">Email *</Label>
                <Input
                  id="email"
                  name="email"
                  type="email"
                  value={formData.email}
                  onChange={handleInputChange}
                  placeholder="you@example.com"
                  required
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="password">Password *</Label>
                <div className="relative">
                  <Input
                    id="password"
                    name="password"
                    type={showPassword ? "text" : "password"}
                    value={formData.password}
                    onChange={handleInputChange}
                    placeholder="At least 6 characters"
                    required
                    minLength={6}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500"
                  >
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="phone">Phone Number</Label>
                <Input
                  id="phone"
                  name="phone"
                  type="tel"
                  value={formData.phone}
                  onChange={handleInputChange}
                  placeholder="0241234567"
                />
              </div>

              <hr className="my-4" />

              <div className="space-y-2">
                <Label htmlFor="shop_name">Shop Name *</Label>
                <Input
                  id="shop_name"
                  name="shop_name"
                  value={formData.shop_name}
                  onChange={handleInputChange}
                  placeholder="My Data Shop"
                  required
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="shop_slug">Shop URL</Label>
                <div className="flex items-center gap-2">
                  <span className="text-sm text-gray-500">yoursite.com/shop/</span>
                  <Input
                    id="shop_slug"
                    name="shop_slug"
                    value={formData.shop_slug}
                    readOnly
                    placeholder="auto-generated-from-name"
                    className="flex-1 bg-gray-50"
                  />
                </div>
                <p className="text-xs text-gray-500">Automatically generated from your shop name</p>
              </div>

              <Alert>
                <AlertCircle className="w-4 h-4" />
                <AlertDescription>
                  By creating an account, you agree to our terms of service.
                </AlertDescription>
              </Alert>

              <Button 
                type="submit" 
                className="w-full bg-blue-600 hover:bg-blue-700 text-white font-semibold py-3 text-lg" 
                disabled={submitting}
              >
                {submitting ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Creating Account...
                  </>
                ) : (
                  "Create Account & Shop"
                )}
              </Button>
            </form>
          </CardContent>
        </Card>

        <p className="text-center text-sm text-gray-500">
          Already have an account?{" "}
          <Link href="/login" className="text-blue-600 hover:underline">
            Log in
          </Link>
        </p>
      </div>
    </div>
  )
}
