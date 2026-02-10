// Add this handler function after handleOrderingToggle (around line 242)

const handleMTNProviderChange = async (provider: "sykes" | "datakazina") => {
    setSavingProvider(true)
    try {
        const { data: { session } } = await supabase.auth.getSession()

        if (!session?.access_token) {
            toast.error("Authentication required")
            setSavingProvider(false)
            return
        }

        const response = await fetch("/api/admin/settings/mtn-provider", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${session.access_token}`,
            },
            body: JSON.stringify({ provider }),
        })

        if (!response.ok) {
            throw new Error("Failed to update MTN provider")
        }

        setMtnProvider(provider)
        toast.success(`MTN provider switched to ${provider === "sykes" ? "Sykes" : "DataKazina"}`)
    } catch (error) {
        console.error("Error updating MTN provider:", error)
        toast.error("Failed to update provider")
    } finally {
        setSavingProvider(false)
    }
}

// ============================================
// Add this UI card after the ordering control card (around line 367)
// ============================================

{/* MTN Provider Selection */ }
<Card className="mb-6 border-blue-200 bg-blue-50">
    <CardHeader>
        <CardTitle className="flex items-center gap-2 text-blue-700">
            <MessageCircle className="w-5 h-5" />
            MTN Fulfillment Provider
        </CardTitle>
    </CardHeader>
    <CardContent>
        <p className="text-sm text-gray-600 mb-4">
            Select which MTN API provider to use for data package fulfillment.
            All NEW orders will use the selected provider. Existing orders will continue with their original provider.
        </p>

        <div className="space-y-3">
            <div
                onClick={() => !savingProvider && handleMTNProviderChange("sykes")}
                className={`p-4 border-2 rounded-lg cursor-pointer transition-all ${mtnProvider === "sykes"
                        ? "border-blue-600 bg-blue-100"
                        : "border-gray-300 bg-white hover:border-blue-400"
                    } ${savingProvider ? "opacity-50 cursor-not-allowed" : ""}`}
            >
                <div className="flex items-center justify-between">
                    <div>
                        <p className="font-semibold text-gray-900">Sykes API</p>
                        <p className="text-sm text-gray-600">Current/Legacy provider</p>
                    </div>
                    <div
                        className={`w-5 h-5 rounded-full border-2 flex items-center justify-center ${mtnProvider === "sykes"
                                ? "border-blue-600 bg-blue-600"
                                : "border-gray-400"
                            }`}
                    >
                        {mtnProvider === "sykes" && (
                            <div className="w-2 h-2 rounded-full bg-white" />
                        )}
                    </div>
                </div>
            </div>

            <div
                onClick={() => !savingProvider && handleMTNProviderChange("datakazina")}
                className={`p-4 border-2 rounded-lg cursor-pointer transition-all ${mtnProvider === "datakazina"
                        ? "border-green-600 bg-green-100"
                        : "border-gray-300 bg-white hover:border-green-400"
                    } ${savingProvider ? "opacity-50 cursor-not-allowed" : ""}`}
            >
                <div className="flex items-center justify-between">
                    <div>
                        <p className="font-semibold text-gray-900">DataKazina API</p>
                        <p className="text-sm text-gray-600">Alternative MTN provider</p>
                    </div>
                    <div
                        className={`w-5 h-5 rounded-full border-2 flex items-center justify-center ${mtnProvider === "datakazina"
                                ? "border-green-600 bg-green-600"
                                : "border-gray-400"
                            }`}
                    >
                        {mtnProvider === "datakazina" && (
                            <div className="w-2 h-2 rounded-full bg-white" />
                        )}
                    </div>
                </div>
            </div>
        </div>

        {savingProvider && (
            <div className="mt-4 flex items-center gap-2 text-blue-700">
                <Loader2 className="w-4 h-4 animate-spin" />
                <span className="text-sm">Updating provider...</span>
            </div>
        )}

        <div className="mt-4 p-3 bg-yellow-50 border border-yellow-200 rounded-lg">
            <p className="text-xs text-yellow-800">
                <strong>Note:</strong> Switching providers only affects NEW orders.
                In-flight orders will continue to use their original provider for status checks.
            </p>
        </div>
    </CardContent>
</Card>
