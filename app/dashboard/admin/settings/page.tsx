"use client"

import { useState, useEffect } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import { toast } from "sonner"

export default function AdminSettingsPage() {
    const [loading, setLoading] = useState(false)
    const [formData, setFormData] = useState({
        support_whatsapp: "",
        support_email: "",
        support_phone: "",
        guest_purchase_url: "",
        guest_purchase_button_text: "Buy as Guest"
    })

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        setFormData({
            ...formData,
            [e.target.name]: e.target.value
        })
    }

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault()
        setLoading(true)

        try {
            const response = await fetch("/api/admin/support-settings", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify(formData)
            })

            const data = await response.json()

            if (response.ok) {
                toast.success("Settings saved successfully!")
            } else {
                toast.error(data.error || "Failed to save settings")
            }
        } catch (error) {
            console.error("Error saving settings:", error)
            toast.error("Failed to save settings")
        } finally {
            setLoading(false)
        }
    }

    return (
        <div className="p-6 max-w-4xl mx-auto">
            <h1 className="text-3xl font-bold mb-6">Admin Settings</h1>

            <form onSubmit={handleSubmit} className="space-y-6">
                {/* Support Contact Settings */}
                <Card>
                    <CardHeader>
                        <CardTitle>Support Contact Information</CardTitle>
                        <CardDescription>
                            Configure customer support contact details
                        </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-4">
                        <div className="space-y-2">
                            <Label htmlFor="support_email">Support Email</Label>
                            <Input
                                id="support_email"
                                name="support_email"
                                type="email"
                                value={formData.support_email}
                                onChange={handleChange}
                                placeholder="support@example.com"
                            />
                        </div>

                        <div className="space-y-2">
                            <Label htmlFor="support_phone">Support Phone</Label>
                            <Input
                                id="support_phone"
                                name="support_phone"
                                value={formData.support_phone}
                                onChange={handleChange}
                                placeholder="+233 XXX XXX XXXX"
                            />
                        </div>

                        <div className="space-y-2">
                            <Label htmlFor="support_whatsapp">WhatsApp Number</Label>
                            <Input
                                id="support_whatsapp"
                                name="support_whatsapp"
                                value={formData.support_whatsapp}
                                onChange={handleChange}
                                placeholder="233XXXXXXXXX"
                                required
                            />
                            <p className="text-sm text-gray-500">
                                Enter in international format without + or spaces
                            </p>
                        </div>
                    </CardContent>
                </Card>

                {/* Guest Purchase Settings */}
                <Card>
                    <CardHeader>
                        <CardTitle>Guest Purchase Configuration</CardTitle>
                        <CardDescription>
                            Configure the "Buy as Guest" button that appears on landing and login pages
                        </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-4">
                        <div className="space-y-2">
                            <Label htmlFor="guest_purchase_url">Guest Purchase URL</Label>
                            <Input
                                id="guest_purchase_url"
                                name="guest_purchase_url"
                                type="url"
                                value={formData.guest_purchase_url}
                                onChange={handleChange}
                                placeholder="https://shop.example.com/purchase"
                            />
                            <p className="text-sm text-gray-500">
                                URL where guests can purchase without logging in. Leave empty to hide the button.
                            </p>
                        </div>

                        <div className="space-y-2">
                            <Label htmlFor="guest_purchase_button_text">Button Text</Label>
                            <Input
                                id="guest_purchase_button_text"
                                name="guest_purchase_button_text"
                                value={formData.guest_purchase_button_text}
                                onChange={handleChange}
                                placeholder="Buy as Guest"
                            />
                            <p className="text-sm text-gray-500">
                                Text displayed on the guest purchase button
                            </p>
                        </div>

                        {formData.guest_purchase_url && (
                            <div className="p-4 bg-blue-50 border border-blue-200 rounded-lg">
                                <p className="text-sm font-medium text-blue-900 mb-2">Preview:</p>
                                <Button variant="outline" type="button" className="pointer-events-none">
                                    {formData.guest_purchase_button_text || "Buy as Guest"}
                                </Button>
                            </div>
                        )}
                    </CardContent>
                </Card>

                <Button type="submit" size="lg" disabled={loading} className="w-full sm:w-auto">
                    {loading ? "Saving..." : "Save Settings"}
                </Button>
            </form>
        </div>
    )
}
