import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { getOrCreateAccountForUser, listUnitTransactions, getPendingUnits } from "@/lib/sms/account-service"

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization")
  if (!authHeader?.startsWith("Bearer ")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  const { data: { user }, error } = await supabaseAdmin.auth.getUser(authHeader.slice(7))
  if (error || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const account = await getOrCreateAccountForUser(user.id)
  if (!account) {
    return NextResponse.json({ error: "No SMS account for this user" }, { status: 403 })
  }
  const [transactions, pendingUnits, settings] = await Promise.all([
    listUnitTransactions(account.id, 20),
    getPendingUnits(account.id),
    supabaseAdmin
      .from("tenant_global_settings")
      .select("key, value")
      .in("key", ["sms_activation_fee", "sms_welcome_bonus_credits"])
      .then(({ data }) => {
        const map: Record<string, number> = {}
        for (const row of (data ?? [])) {
          const r = row as { key: string; value: { amount?: number; units?: number } }
          if (r.key === "sms_activation_fee") map.activationFee = Number(r.value.amount ?? 0)
          if (r.key === "sms_welcome_bonus_credits") map.welcomeBonusCredits = Number(r.value.units ?? 0)
        }
        return map
      }),
  ])
  return NextResponse.json({
    account: {
      id: account.id,
      ownerType: account.owner_type,
      unitBalance: account.unit_balance,
      pendingUnits,
      status: account.status,
      activatedAt: account.activated_at ?? null,
      amountPaid: account.amount_paid ?? null,
      paidFrom: account.paid_from ?? null,
      bonusClaimed: account.bonus_claimed ?? false,
      bonusClaimedAt: account.bonus_claimed_at ?? null,
      activationFee: settings.activationFee ?? 20,
      welcomeBonusCredits: settings.welcomeBonusCredits ?? 10,
    },
    transactions,
  })
}
