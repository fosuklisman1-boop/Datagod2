/** Admin display labels for bot orders (`channel = 'bots'`, `bot_surface` per migration 0123). Client-safe. */
export const BOT_SURFACE_LABEL: Record<string, string> = {
  hubtel_ussd: "Hubtel USSD",
  ussd: "USSD",
  ussd_shop: "Shop USSD",
  whatsapp: "WhatsApp",
  whatsapp_shop: "Shop WhatsApp",
}

/** "Bot · Hubtel USSD"; unknown or missing surfaces degrade to plain "Bot". */
export function botChannelLabel(surface: string | null | undefined): string {
  const s = surface ? (BOT_SURFACE_LABEL[surface] ?? surface) : ""
  return s ? `Bot · ${s}` : "Bot"
}
