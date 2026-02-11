export const supportSettingsService = {
  // Get support settings
  async getSupportSettings() {
    try {
      const response = await fetch("/api/support-settings")
      if (!response.ok) {
        throw new Error("Failed to fetch support settings")
      }
      const result = await response.json()
      return result.data || null
    } catch (error: any) {
      console.error("Error fetching support settings:", error)
      // Return defaults on error
      return {
        support_whatsapp: "233501234567",
        support_email: "support@datagod.com",
        support_phone: "0501234567"
      }
    }
  },

  // Update support settings (admin only)
  async updateSupportSettings(
    support_whatsapp: string,
    support_email?: string,
    support_phone?: string,
    guest_purchase_url?: string,
    guest_purchase_button_text?: string
  ) {
    try {
      const response = await fetch("/api/admin/support-settings", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          support_whatsapp,
          support_email,
          support_phone,
          guest_purchase_url,
          guest_purchase_button_text
        }),
      })

      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.error || "Failed to update support settings")
      }

      return await response.json()
    } catch (error: any) {
      console.error("Error updating support settings:", error)
      throw error
    }
  },

  // Get WhatsApp URL for contact
  formatWhatsAppURL(phoneNumber: string, message?: string) {
    // Remove any non-digit characters
    const cleanNumber = phoneNumber.replace(/\D/g, "")
    const url = new URL("https://wa.me/" + cleanNumber)
    if (message) {
      url.searchParams.append("text", message)
    }
    return url.toString()
  }
}
