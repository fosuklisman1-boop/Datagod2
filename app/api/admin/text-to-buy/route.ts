import { NextRequest } from "next/server"
import { loadTtbSettings, TTB_SETTING_KEYS, type TtbSettingField, type TtbSettingKey, type TtbSettings } from "@/lib/text-to-buy/settings"
import { normaliseSender, validateTtbSettings } from "@/lib/text-to-buy/admin-validate"
import { buildOverview, SMS_RATE_GHS, startOfTodayAccra, UUID_RE } from "@/lib/text-to-buy/admin-view"
import { blockSender, getHeartbeat, markMisread, overviewRows, saveSettingRows, serviceCountsToday, unblockSender } from "@/lib/text-to-buy/store"
import { fail, gate, isResponse, json, logError, readObject } from "@/lib/text-to-buy/admin-http"
import { notifyTextToBuyAdmins } from "@/lib/admin-actions/text-to-buy"

// Text-to-Buy admin API: overview, settings, block / unblock a sender, flag a misread. Never log message text, numbers,
// reasons or setting values.
export const dynamic = "force-dynamic"

const FIELD_OF = Object.fromEntries(Object.entries(TTB_SETTING_KEYS).map(([f, k]) => [k, f])) as Record<TtbSettingKey, TtbSettingField>
const KEY_ORDER = Object.values(TTB_SETTING_KEYS) as TtbSettingKey[]

/** Switching any of these on needs an explicit confirm. */
const CONFIRM_KEYS: TtbSettingKey[] = [TTB_SETTING_KEYS.mainEnabled, TTB_SETTING_KEYS.airtimeEnabled, TTB_SETTING_KEYS.resultsCheckerEnabled]

/** The settings as the page sees them (no internal source marker). */
function publicSettings(s: TtbSettings) {
  const { source: _source, ...rest } = s
  return rest
}

export async function GET(request: NextRequest) {
  const ctx = await gate(request, false)
  if (isResponse(ctx)) return ctx
  const { db } = ctx
  try {
    const now = new Date()
    const [settings, rows, main, shop, services] = await Promise.all([
      loadTtbSettings(db),
      overviewRows(db, startOfTodayAccra(now)),
      getHeartbeat(db, "main"),
      getHeartbeat(db, "shop"),
      serviceCountsToday(db, startOfTodayAccra(now)),
    ])
    return json({
      settingsDefaulted: settings.source === "defaults",
      settings: publicSettings(settings),
      overview: buildOverview(rows, { main, shop }, { enabled: settings.mainEnabled, number: settings.mainNumber }),
      smsRateGhs: SMS_RATE_GHS,
      services,
    })
  } catch (err) {
    logError("get", err)
    return fail("server_error", 500)
  }
}

export async function PUT(request: NextRequest) {
  const ctx = await gate(request, true)
  if (isResponse(ctx)) return ctx
  const { db, userId } = ctx

  const body = await readObject(request)
  if (!body) return fail("invalid_body", 400)
  const { confirm, ...rest } = body
  if (confirm !== undefined && typeof confirm !== "boolean") return fail("invalid_confirm", 400)

  // The whole patch is checked before anything is written.
  const v = validateTtbSettings(rest)
  if (!v.ok) return fail(v.error, 400)

  try {
    // Change detection and the "turning it on" check both need the saved values: a failed load must not be treated as them.
    const current = await loadTtbSettings(db)
    if (current.source === "defaults") return fail("settings_unavailable", 409)

    const changed: Partial<Record<TtbSettingKey, unknown>> = {}
    for (const key of KEY_ORDER) {
      if (!(key in v.patch)) continue
      if (v.patch[key] !== current[FIELD_OF[key]]) changed[key] = v.patch[key]
    }
    const changedKeys = Object.keys(changed) as TtbSettingKey[]
    if (changedKeys.length === 0) return json({ settings: publicSettings(current) })

    // Switching the feature on puts live customer texts on the order path: the page must have asked the admin first.
    // The airtime and checker text switches put a money path on the same lane, so they ask the same question.
    const turnsOn = CONFIRM_KEYS.some((k) => changed[k] === true)
    if (turnsOn && confirm !== true) return fail("confirm_required", 400)

    await saveSettingRows(db, changed, userId as string, new Date())

    // One alert, names only. notifyTextToBuyAdmins never throws and never changes the response.
    await notifyTextToBuyAdmins({ kind: "setting_changed", keys: changedKeys })

    const next = { ...current } as Record<string, unknown>
    for (const key of changedKeys) next[FIELD_OF[key]] = changed[key]
    return json({ settings: publicSettings(next as unknown as TtbSettings) })
  } catch (err) {
    logError("settings", err)
    return fail("save_failed", 500)
  }
}

export async function POST(request: NextRequest) {
  const ctx = await gate(request, true)
  if (isResponse(ctx)) return ctx
  const { db, userId } = ctx

  const body = await readObject(request)
  if (!body) return fail("invalid_body", 400)
  const action = body.action

  try {
    if (action === "block" || action === "unblock") {
      const sender = normaliseSender(body.sender)
      if (!sender) return fail("invalid_sender", 400)
      if (action === "unblock") return json({ ok: true, removed: await unblockSender(db, sender) })

      let reason: string | null = null
      if (body.reason !== undefined && body.reason !== null) {
        if (typeof body.reason !== "string") return fail("invalid_reason", 400)
        const t = body.reason.trim()
        if (t.length > 200) return fail("invalid_reason", 400)
        reason = t === "" ? null : t
      }
      await blockSender(db, sender, reason, userId as string)
      return json({ ok: true })
    }

    if (action === "misread") {
      const id = body.messageId
      if (typeof id !== "string" || !UUID_RE.test(id)) return fail("invalid_message", 400)
      return (await markMisread(db, id)) ? json({ ok: true }) : fail("not_found", 404)
    }

    return fail("invalid_action", 400)
  } catch (err) {
    logError("action", err)
    return fail("server_error", 500)
  }
}
