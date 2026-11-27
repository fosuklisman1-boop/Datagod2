import { createClient } from "@supabase/supabase-js"
import { sendSMS, SMSTemplates } from "@/lib/sms-service"
import { raiseSecurityAlert } from "@/lib/security-alerts"
import type { FlowDeps } from "@/lib/phone-login/flow"
import { getPhoneLoginSettings } from "@/lib/phone-login/settings"
import { defaultSessionDeps } from "@/lib/phone-login/session"

/** Built once per request by each phone-login route (tests mock this module). */
export function buildFlowDeps(): FlowDeps {
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL || "", process.env.SUPABASE_SERVICE_ROLE_KEY || "", {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  return {
    db,
    session: defaultSessionDeps(),
    settings: () => getPhoneLoginSettings(),
    sendCode: (phone, code) => sendSMS({ phone, message: SMSTemplates.phoneLoginCode(code), type: "phone_otp" }),
    alert: raiseSecurityAlert,
    now: () => new Date(),
    emailForUser: async (id) => {
      const { data, error } = await db.auth.admin.getUserById(id)
      if (error) throw error
      return data?.user?.email ?? null
    },
  }
}
