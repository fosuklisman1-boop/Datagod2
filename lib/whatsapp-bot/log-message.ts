// lib/whatsapp-bot/log-message.ts
//
// Shared WhatsApp message logger. Upserts the conversation row, inserts the
// message, and refreshes the conversation preview/timestamps. Returns the
// conversation's current human-takeover state so the inbound webhook can reuse
// this single call to decide whether the bot should stay silent — no extra
// round-trip. Used by the inbound webhook and the admin inbox send endpoint.
import { createClient } from "@supabase/supabase-js"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export interface LogMessageResult {
  conversationId: string | null
  humanTakeover: boolean
  takenOverAt: string | null
  takenOverBy: string | null
  // created_at of the conversation row — lets callers detect a brand-new
  // conversation (created_at ≈ now) without a separate count query.
  conversationCreatedAt: string | null
  // True only when this was an inbound message whose meta_message_id collided
  // with the partial unique index (idx_whatsapp_messages_inbound_meta_id_unique)
  // — i.e. Meta redelivered a webhook event we already processed. The insert
  // itself is the atomic dedup check (closes a check-then-act race a separate
  // SELECT-before-insert can't: two near-simultaneous deliveries could both
  // pass a "not yet seen" check before either had inserted). Callers that care
  // about duplicates (the inbound webhook) should bail out immediately on true.
  duplicate: boolean
}

export async function logMessage(
  phone: string,
  direction: "inbound" | "outbound",
  message: string,
  metaMessageId: string | null,
  media?: { url: string; type: string } | null,
  // The sender's WhatsApp display name (inbound only). Stored so guest
  // conversations show a real name; only written when non-empty so it never
  // clobbers an existing name with a blank.
  profileName?: string | null
): Promise<LogMessageResult> {
  try {
    // Upsert the conversation AND its preview/timestamps in one statement, then
    // read back the takeover state in the same round-trip. Writing changed
    // columns guarantees PostgREST returns the row (so the takeover flag is
    // never lost) and collapses the old upsert + separate update into one query.
    const nowIso = new Date().toISOString()
    const convFields: Record<string, unknown> = {
      phone_number: phone,
      last_message_preview: message.slice(0, 100),
      updated_at: nowIso,
    }
    if (direction === "inbound") convFields.latest_inbound_at = nowIso
    else convFields.latest_outbound_at = nowIso
    if (profileName && profileName.trim()) convFields.wa_profile_name = profileName.trim()

    const { data: conv } = await supabase
      .from("whatsapp_conversations")
      .upsert(convFields, { onConflict: "phone_number" })
      .select("id, human_takeover, taken_over_at, taken_over_by, created_at")
      .maybeSingle()

    const conversationId = conv?.id ?? null

    const { error: insertError } = await supabase.from("whatsapp_messages").insert({
      conversation_id: conversationId,
      direction,
      phone_number: phone,
      message,
      meta_message_id: metaMessageId,
      status: "sent",
      tool_context: media ? { media_url: media.url, media_type: media.type } : null,
    })

    // 23505 = unique_violation. For an inbound message this means Meta
    // redelivered a webhook event already logged — the insert hitting
    // idx_whatsapp_messages_inbound_meta_id_unique IS the atomic dedup check.
    if (insertError) {
      if (insertError.code === "23505") {
        return {
          conversationId,
          humanTakeover: conv?.human_takeover === true,
          takenOverAt: conv?.taken_over_at ?? null,
          takenOverBy: conv?.taken_over_by ?? null,
          conversationCreatedAt: conv?.created_at ?? null,
          duplicate: true,
        }
      }
      throw insertError
    }

    // Push the admin inbox so it updates instantly instead of on the next poll.
    const { notifyInboxChange } = await import("./realtime-notify")
    notifyInboxChange(phone, direction)

    return {
      conversationId,
      humanTakeover: conv?.human_takeover === true,
      takenOverAt: conv?.taken_over_at ?? null,
      takenOverBy: conv?.taken_over_by ?? null,
      conversationCreatedAt: conv?.created_at ?? null,
      duplicate: false,
    }
  } catch (e) {
    console.warn("[WA-LOG] logMessage failed (non-fatal):", e)
    return { conversationId: null, humanTakeover: false, takenOverAt: null, takenOverBy: null, conversationCreatedAt: null, duplicate: false }
  }
}
