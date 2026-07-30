import { createClient } from "@supabase/supabase-js"
import { sendWhatsAppText } from "./send"
import { logMessage } from "./log-message"
import { getSession, setSession, deleteSession } from "./shop-session"
import {
  shopProductMenu, shopNetworkMenu, shopBundleMenu, shopRecipientPrompt,
  shopPaymentPhonePrompt, shopInvalidPaymentPhoneMenu, shopConfirmMenu,
  shopPaymentSentMenu, shopOtpMenu, shopInvalidCodeMenu, sortNetworks, PAGE_SIZE,
  shopAirtimeRecipientPrompt, shopAirtimeNetworkMenu, shopAirtimeAmountPrompt, shopAirtimeConfirmMenu,
  shopRcBoardMenu, shopRcQtyPrompt, shopRcConfirmMenu,
} from "./shop-menus"
import { resolveShopCode, fetchShopNetworks } from "@/lib/shop-commerce/shop-code"
import { getShopPref, setShopPref, clearShopPref } from "@/lib/whatsapp-bot/shop-prefs"
import type { WaShopSession } from "./shop-types"
import { fetchShopBundles, verifyBundlePrice, shopOwnerIsDealer } from "@/lib/shop-commerce/pricing"
import { createShopBundleOrder, createShopAirtimeOrder, createShopRcOrder } from "@/lib/shop-commerce/orders"
import { chargeMobileMoney, submitOtp } from "@/lib/paystack"
import { paystackProviderFromPhone } from "@/lib/ussd/paystack-provider"
import { validateNetworkPrefix } from "@/lib/phone-format"
import { getPrefixValidationConfig } from "@/lib/network-prefix-config"
import { resolveEmail } from "@/lib/ussd/resolve-email"
import {
  detectAirtimeNetwork, isAirtimeEnabled, getAirtimeLimits,
  airtimeBaseFeeRate, splitInclusive, airtimeNetworkKey,
} from "@/lib/airtime-pricing"
import {
  isExamBoardEnabled, getAvailableCount, getMaxQuantity, calculateRCPrice, getRCBulkHint,
  type ExamBoard,
} from "@/lib/results-checker-service"
import { buildRcBoardOptions } from "@/lib/ussd/handlers/results-checker"
import { secureReference } from "@/lib/secure-random"

// Handles inbound messages that arrived on the dedicated shop WhatsApp number
// (identified by phone_number_id in the webhook payload, wired in
// app/api/whatsapp/webhook/route.ts). Full purchase state machine for all three
// shop products (Data, Airtime, Results Checker) — mirrors lib/ussd-shop/router.ts
// + handlers/{bundles,airtime,results-checker}.ts's control flow, but rendered as
// WhatsApp text (lib/whatsapp-bot/shop-menus.ts) and persisted via
// lib/whatsapp-bot/shop-session.ts instead of the USSD dial-session.
//
// Two ad-hoc reads (the shop owner's account email, and the current Paystack
// direct-charge fee %) don't have a shared lib/shop-commerce home — they're
// resolved inline here with this module's own Supabase client, exactly mirroring
// how lib/ussd-shop/handlers/bundles.ts's handleConfirm resolves them today.
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

async function fetchShopOwnerEmail(shopId: string): Promise<string | null> {
  const { data } = await supabase
    .from("user_shops")
    .select("user_id, users!inner(email)")
    .eq("id", shopId)
    .single()
  return (data as any)?.users?.email ?? null
}

async function fetchPaystackFeePercent(): Promise<number> {
  const { data } = await supabase
    .from("app_settings")
    .select("paystack_fee_percentage")
    .is("key", null)
    .single()
  return (data?.paystack_fee_percentage ?? 3.0) / 100
}

// Shared order-status writers for all three shop order tables, used by every
// CONFIRM/SUBMIT_OTP outcome that isn't the normal happy path. Without these, an
// order row can be left stuck at pending/pending indefinitely: there's no cron
// that reconciles ussd_shop_orders/airtime_orders/results_checker_orders (only
// shop_orders is covered by verify-pending-payments), and several of these
// outcomes (chargeMobileMoney throwing, an OTP Paystack rejects) will never
// produce a charge.failed webhook to reconcile it either.
//
// Generalized (table param) so Data/Airtime/RC share one implementation — was
// hardcoded to ussd_shop_orders only when Data was the sole product built.
// ussd_shop_orders' broad-status column is `order_status`; airtime_orders and
// results_checker_orders use `status` instead (mirrors lib/ussd/handlers/otp.ts's
// SECONDARY_STATUS_COL note and lib/ussd-shop/handlers/{airtime,results-checker}.ts's
// CONFIRM catch blocks, which this exactly replicates for the WhatsApp channel).
export type ShopOrderTable = 'ussd_shop_orders' | 'airtime_orders' | 'results_checker_orders'

const BROAD_STATUS_COL: Record<ShopOrderTable, 'order_status' | 'status'> = {
  ussd_shop_orders: 'order_status',
  airtime_orders: 'status',
  results_checker_orders: 'status',
}

async function markOrderFailed(table: ShopOrderTable, orderId: string): Promise<void> {
  try {
    await supabase
      .from(table)
      .update({ [BROAD_STATUS_COL[table]]: 'failed', payment_status: 'failed', updated_at: new Date().toISOString() })
      .eq("id", orderId)
  } catch (err) {
    console.error("[WA-SHOP] failed to mark order failed:", table, orderId, err)
  }
}

async function markOrderOtpRequired(table: ShopOrderTable, orderId: string): Promise<void> {
  try {
    await supabase
      .from(table)
      .update({ payment_status: 'otp_required', updated_at: new Date().toISOString() })
      .eq("id", orderId)
  } catch (err) {
    console.error("[WA-SHOP] failed to mark order otp_required:", table, orderId, err)
  }
}

// Mirrors lib/ussd-shop/handlers/airtime.ts's private (unexported)
// shopAirtimeFeeRate — the platform's per-tier base fee (lib/airtime-pricing.ts's
// airtimeBaseFeeRate) plus this shop's own airtime_markup_{network} column,
// capped so base+markup never exceeds 10% (mirrors the storefront rule). Reuses
// the shared shopOwnerIsDealer (lib/shop-commerce/pricing.ts) for the dealer-tier
// check instead of duplicating its public.users-vs-auth.users lookup pitfall.
async function shopAirtimeFeeRate(
  shopId: string,
  network: string
): Promise<{ totalFeeRate: number; merchantCommissionRate: number }> {
  const isDealer = await shopOwnerIsDealer(shopId)
  const baseRate = await airtimeBaseFeeRate(network, isDealer)

  const { data: shop } = await supabase
    .from("user_shops")
    .select(`airtime_markup_${airtimeNetworkKey(network)}`)
    .eq("id", shopId)
    .single()

  const rawMarkup = parseFloat((shop as any)?.[`airtime_markup_${airtimeNetworkKey(network)}`] ?? 0) || 0
  const cappedMarkup = Math.max(0, Math.min(rawMarkup, 10 - baseRate))
  return { totalFeeRate: baseRate + cappedMarkup, merchantCommissionRate: cappedMarkup }
}

// Shared "we don't recognise this MoMo number's provider" reply — same wording
// used by the payment-phone step of all three products.
function shopNoProviderMessage(): string {
  return "Payment isn't available for that number.\nEnter a different MoMo number:\n(e.g. 0244123456)\n\n0. Cancel"
}

// CONFIRM-time anti-race token check. A shop's ussd_shop_codes.token_balance is a
// SHARED pool across USSD + WhatsApp (design doc: "sessions stay shared with
// USSD"), and a WhatsApp session can sit for up to 30 minutes (shop-session.ts's
// TTL) between the initial ENTER_CODE gate and CONFIRM — long enough for the
// shop's last token to be consumed elsewhere in that window. Re-reading it here,
// right before creating the order, closes that gap (USSD doesn't need this: it
// deducts synchronously at dial-in, not at confirm).
async function fetchShopCodeTokenBalance(shopCodeId: string): Promise<number | null> {
  const { data } = await supabase
    .from("ussd_shop_codes")
    .select("token_balance")
    .eq("id", shopCodeId)
    .maybeSingle()
  return data?.token_balance ?? null
}

// resolveShopCode takes a code string, not an id — the returning-customer path
// only has the remembered shopCodeId, so look up the code string first.
async function resolveShopCodeById(shopCodeId: string) {
  const { data } = await supabase.from("ussd_shop_codes").select("code").eq("id", shopCodeId).maybeSingle()
  if (!data?.code) return null
  return resolveShopCode(data.code)
}

// Data-bundle whitelist gate — mirrors lib/ussd-shop/handlers/shop.ts's
// handleEnterShopCode (builds session.dataBlocked, gating the product menu) and
// lib/ussd-shop/handlers/bundles.ts's handleSelectNetwork (a second check right
// before fetching bundles). When ON, only customers with a prior completed
// purchase may buy data through the shop bot.
async function isDataWhitelistBlocked(msisdn: string): Promise<boolean> {
  const localPhone = normalizeGhanaLocal(msisdn)
  const [{ data: whitelistSetting }, { data: hasPurchasedData }] = await Promise.all([
    supabase.from("admin_settings").select("value").eq("key", "ussd_data_whitelist_enabled").maybeSingle(),
    supabase.rpc("has_completed_purchase", { local_phone: localPhone, msisdn }),
  ])
  return (whitelistSetting as any)?.value?.enabled === true && hasPurchasedData !== true
}

// Ghana phone normalisation shared by ENTER_RECIPIENT and ENTER_PAYMENT_PHONE —
// same accepted formats/regex as the main WA bot's WA_ENTER_PAYMENT_PHONE step
// (lib/whatsapp-bot/router.ts's handleWaEnterPaymentPhone) and the USSD shop's
// handleEnterRecipient (lib/ussd-shop/handlers/bundles.ts).
function normalizeGhanaLocal(raw: string): string {
  const stripped = raw.trim().replace(/\s+/g, '')
  if (stripped.startsWith('+233')) return '0' + stripped.slice(4)
  if (stripped.startsWith('233')) return '0' + stripped.slice(3)
  return stripped
}
function isValidLocalGhana(local: string): boolean {
  return /^0[0-9]{9}$/.test(local)
}

// Distinguishes an attempted (but wrong/typo'd) shop code from freetext that
// isn't a code attempt at all — gates whether a failed resolveShopCode lookup
// (no session, no remembered shop) shows the robotic "Invalid shop code" menu
// or escapes to the AI's "no shop known" conversational branch (see
// lib/whatsapp-bot/shop-ai.ts's handleShopWithAI). Shop codes are always a
// single token: auto-generated ones are 4/6-digit numeric strings
// (secureNumericCode in app/api/admin/ussd-shops/route.ts), but an admin can
// also set an arbitrary custom code manually, so this deliberately doesn't
// assume numeric-only — just "one short-ish token, no whitespace". Minimum
// length 4 (not 1) matters in production: a customer answering a mid-flow AI
// question the router had already escaped to (e.g. AI asks "how many?" and
// the customer replies "9") looks exactly like a one-token, no-whitespace
// "code attempt" too, and a bare digit or two was wrongly bounced with
// "Invalid shop code" instead of continuing the AI conversation — confirmed
// in production. No real shop code is ever shorter than 4 characters, so
// anything under that length is far more likely to be a stray reply than an
// attempted code.
function looksLikeShopCodeAttempt(input: string): boolean {
  return /^\S{4,20}$/.test(input)
}

// Converts obvious natural-language phrases to a menu digit, at zero AI cost —
// mirrors lib/whatsapp-bot/router.ts's naturalToDigit for the main bot. Returns
// null when the input doesn't map to anything recognisable, signalling the
// caller should escape to AI instead. Deliberately narrow: only steps where a
// customer might reasonably type a network/size/yes-no word instead of a digit.
function shopNaturalToDigit(step: WaShopSession['step'], input: string): string | null {
  const lc = input.trim().toLowerCase()

  if (step === 'SELECT_NETWORK' || step === 'AIRTIME_SELECT_NETWORK') {
    if (/^mtn$/.test(lc)) return '1'
    if (/telecel|vodafone/.test(lc)) return '2'
    if (/airteltigo|airtel|tigo|^at$/.test(lc)) return '3'
  }

  if (step === 'CONFIRM' || step === 'AIRTIME_CONFIRM' || step === 'RC_CONFIRM') {
    if (/^(yes|pay|confirm|ok|okay)$/.test(lc)) return '1'
    if (/^(no|cancel|stop)$/.test(lc)) return '2'
  }

  return null
}

export async function shopWaRouter(from: string, text: string, inboundMsgId: string | null): Promise<string> {
  await logMessage(from, "inbound", text, inboundMsgId)

  let input = text.trim()
  let session = await getSession(from)
  // Definite-assignment assertion: every reachable path below assigns reply
  // before it's used (each branch of the !session chain, and every switch
  // case/default in the else branch), but TS's DA analysis can't correlate
  // that guarantee across the matchedReturning flag introduced by the
  // returning-customer path, so it can't prove it unaided.
  let reply!: string
  let deleteAfter = false
  // Set only for the "no session, code didn't resolve" branch — nothing was ever
  // created, so there's nothing to persist or delete; the next message retries.
  let skipPersist = false

  if (!session) {
    // Returning-customer memory: a bare greeting/empty-ish first message with a
    // remembered shop skips straight to the product menu instead of re-asking
    // for the code. Any OTHER input (e.g. actually typing a new code) still goes
    // through resolveShopCode below, so typing a different valid code always
    // switches shops. matchedReturning gates the resolveShopCode chain below so
    // a successful match doesn't also run it.
    let matchedReturning = false
    const pref = await getShopPref(from)
    const looksLikeGreeting = /^(hi|hello|hey|start|menu)?$/i.test(input)
    if (pref && looksLikeGreeting) {
      const remembered = await resolveShopCodeById(pref.shopCodeId)
      // Same three checks every other shop-resolution path in this file makes
      // (the !matchedReturning chain below, and resolve_shop_code in
      // lib/ai-tools.ts) — a shop that's since gone inactive, deactivated
      // WhatsApp, or run out of sessions must fall through to the normal
      // code-entry flow instead of showing a stale "Welcome back" + product
      // menu that would only fail later at CONFIRM.
      if (remembered && remembered.status === 'active' && remembered.whatsappActivated && remembered.tokenBalance > 0) {
        const [networks, dataBlocked] = await Promise.all([
          fetchShopNetworks(remembered.shopId, remembered.parentShopId),
          isDataWhitelistBlocked(from),
        ])
        session = {
          step: 'SELECT_PRODUCT',
          shopCodeId: remembered.shopCodeId,
          shopId: remembered.shopId,
          parentShopId: remembered.parentShopId ?? undefined,
          shopName: remembered.shopName,
          networks,
          dataBlocked,
        }
        reply = `Welcome back to *${remembered.shopName}* 👋\n\n${shopProductMenu(remembered.shopName, !dataBlocked)}`
        matchedReturning = true
      } else {
        await clearShopPref(from)
      }
    }

    if (!matchedReturning) {
      const resolved = await resolveShopCode(input)

      if (!resolved) {
        // A bare greeting word ("Hi"/"Hello"/...) passes looksLikeShopCodeAttempt
        // (it's one token, no whitespace) but is never actually a code attempt —
        // confirmed in production: real customers' first message is overwhelmingly
        // "Hi"/"Hello", and without this exclusion every one of them hit the
        // robotic "Invalid shop code" reply instead of ever reaching the AI.
        if (looksLikeShopCodeAttempt(input) && !looksLikeGreeting) {
          reply = shopInvalidCodeMenu('Invalid shop code. Please check and try again.')
          skipPersist = true
        } else {
          // Not code-shaped at all, or a bare greeting — most likely a brand-new
          // customer's genuine question/greeting (e.g. "hi, do you sell mtn data?"
          // or just "Hi"), not a typo'd code. No session was ever created in this
          // path (session stays null all the way through when resolved is falsy),
          // so there's nothing to persist or delete — just escape straight to the
          // AI, which has its own "no shop known" branch that greets and asks for
          // the shop code naturally (lib/whatsapp-bot/shop-ai.ts's handleShopWithAI).
          return ''
        }
      } else if (resolved.status !== 'active') {
        reply = shopInvalidCodeMenu('This shop is currently unavailable.')
        skipPersist = true
      } else if (resolved.tokenBalance <= 0) {
        reply = shopInvalidCodeMenu('This shop has no sessions left. Please contact the seller.')
        skipPersist = true
      } else if (!resolved.whatsappActivated) {
        reply = shopInvalidCodeMenu("This shop isn't set up for WhatsApp yet.")
        skipPersist = true
      } else {
        const [networks, dataBlocked] = await Promise.all([
          fetchShopNetworks(resolved.shopId, resolved.parentShopId),
          isDataWhitelistBlocked(from),
        ])
        session = {
          step: 'SELECT_PRODUCT',
          shopCodeId: resolved.shopCodeId,
          shopId: resolved.shopId,
          parentShopId: resolved.parentShopId ?? undefined,
          shopName: resolved.shopName,
          networks,
          dataBlocked,
        }
        reply = shopProductMenu(resolved.shopName, !dataBlocked)
        await setShopPref(from, resolved.shopCodeId)
      }
    }
  } else {
    const shopName = session.shopName ?? 'Shop'

    // AI escape: money-moving steps never leave the deterministic flow (a
    // gentle re-prompt happens inside their own case below via the existing
    // "else fall through to menu" pattern — we only escape from steps that
    // don't move money). FREE_TEXT_ENTRY_STEPS are exempt for a different
    // reason: they were never "type a menu digit" steps in the first place —
    // ENTER_RECIPIENT/AIRTIME_ENTER_RECIPIENT take a phone number
    // (normalizeGhanaLocal accepts "+233..." prefixes and internal spaces,
    // neither of which is all-digits) and AIRTIME_ENTER_AMOUNT takes a
    // currency amount via parseFloat (a decimal point isn't all-digits
    // either). Each of those steps already validates and re-prompts on bad
    // input in its own case body below, so gating them through the AI escape
    // would destroy an in-progress purchase over a phone number format or a
    // decimal point. Everywhere else, digits pass straight through; obvious
    // phrases resolve via shopNaturalToDigit; anything else escapes to AI.
    const MONEY_STEPS: WaShopSession['step'][] = [
      'CONFIRM', 'AIRTIME_CONFIRM', 'RC_CONFIRM',
      'ENTER_PAYMENT_PHONE', 'AIRTIME_ENTER_PAYMENT_PHONE', 'RC_ENTER_PAYMENT_PHONE',
      'SUBMIT_OTP',
    ]
    const FREE_TEXT_ENTRY_STEPS: WaShopSession['step'][] = [
      'ENTER_RECIPIENT', 'AIRTIME_ENTER_RECIPIENT', 'AIRTIME_ENTER_AMOUNT',
    ]
    const isDigitOrZero = /^[0-9]+$/.test(input)
    if (!isDigitOrZero && !MONEY_STEPS.includes(session.step) && !FREE_TEXT_ENTRY_STEPS.includes(session.step)) {
      const mapped = shopNaturalToDigit(session.step, input)
      if (mapped !== null) {
        input = mapped
      } else {
        await deleteSession(from)
        return ''
      }
    }

    switch (session.step) {
      // ── SELECT_PRODUCT ──────────────────────────────────────────────────────
      case 'SELECT_PRODUCT': {
        const dataBlocked = session.dataBlocked === true

        if (dataBlocked) {
          // Renumbered menu (no Data option at all): 1=Airtime, 2=Results Checker.
          if (input === '1') {
            session.step = 'AIRTIME_ENTER_RECIPIENT'
            reply = shopAirtimeRecipientPrompt(shopName)
          } else if (input === '2') {
            const boards = await buildRcBoardOptions()
            if (boards.length === 0) {
              reply = `Results Checker unavailable.\n\n${shopProductMenu(shopName, false)}`
            } else {
              session.step = 'RC_SELECT_BOARD'
              session.rcBoardOptions = boards
              reply = shopRcBoardMenu(shopName, boards)
            }
          } else if (input === '0') {
            deleteAfter = true
            reply = 'Goodbye.'
          } else {
            reply = shopProductMenu(shopName, false)
          }
          break
        }

        if (input === '1') {
          const networks = session.networks ?? []
          if (networks.length === 0) {
            reply = `No data bundles available for this shop.\n\n${shopProductMenu(shopName)}`
          } else {
            session.step = 'SELECT_NETWORK'
            reply = shopNetworkMenu(shopName, networks)
          }
        } else if (input === '2') {
          session.step = 'AIRTIME_ENTER_RECIPIENT'
          reply = shopAirtimeRecipientPrompt(shopName)
        } else if (input === '3') {
          const boards = await buildRcBoardOptions()
          if (boards.length === 0) {
            reply = `Results Checker unavailable.\n\n${shopProductMenu(shopName)}`
          } else {
            session.step = 'RC_SELECT_BOARD'
            session.rcBoardOptions = boards
            reply = shopRcBoardMenu(shopName, boards)
          }
        } else if (input === '0') {
          deleteAfter = true
          reply = 'Goodbye.'
        } else {
          reply = shopProductMenu(shopName)
        }
        break
      }

      // ── SELECT_NETWORK ──────────────────────────────────────────────────────
      case 'SELECT_NETWORK': {
        const networks = sortNetworks(session.networks ?? [])
        if (input === '0') {
          session.step = 'SELECT_PRODUCT'
          reply = shopProductMenu(shopName, !(session.dataBlocked === true))
          break
        }
        const idx = parseInt(input, 10) - 1
        const selectedNetwork = Number.isNaN(idx) ? undefined : networks[idx]
        if (!selectedNetwork) {
          reply = shopNetworkMenu(shopName, networks)
          break
        }

        // Second whitelist check, right before fetching bundles — defense in
        // depth against the whitelist/purchase status changing between the
        // product-menu gate above and this selection (mirrors USSD's
        // handleSelectNetwork, which re-checks here too rather than trusting
        // only the flag set at code entry).
        if (await isDataWhitelistBlocked(from)) {
          reply = 'Data bundles not available.\nSign up on our app\nto unlock this service.\n\n' + shopNetworkMenu(shopName, networks)
          break
        }

        const allBundles = await fetchShopBundles(session.shopId!, selectedNetwork, session.parentShopId)
        if (allBundles.length === 0) {
          reply = `No ${selectedNetwork} bundles available.\n\n${shopNetworkMenu(shopName, networks)}`
          break
        }

        const firstMenu = shopBundleMenu(shopName, allBundles.slice(0, PAGE_SIZE), 0, allBundles.length)
        session.step = 'SELECT_BUNDLE'
        session.network = selectedNetwork
        session.bundlePage = 0
        session.bundleCache = allBundles
        session.bundleTotal = allBundles.length
        session.bundlePageShown = firstMenu.shown
        reply = firstMenu.text
        break
      }

      // ── SELECT_BUNDLE ───────────────────────────────────────────────────────
      case 'SELECT_BUNDLE': {
        if (input === '0') {
          session.step = 'SELECT_NETWORK'
          session.bundlePage = 0
          reply = shopNetworkMenu(shopName, session.networks ?? [])
          break
        }

        const page = session.bundlePage ?? 0
        const allBundles = session.bundleCache ?? []
        const total = session.bundleTotal ?? allBundles.length
        const offset = page * PAGE_SIZE
        const pageSlice = allBundles.slice(offset, offset + PAGE_SIZE)
        const shown = session.bundlePageShown ?? pageSlice.length
        const moreIndex = offset + shown + 1
        const chosen = parseInt(input, 10)

        if (chosen === moreIndex && offset + shown < total) {
          const nextPage = page + 1
          const nextSlice = allBundles.slice(nextPage * PAGE_SIZE, (nextPage + 1) * PAGE_SIZE)
          const nextMenu = shopBundleMenu(shopName, nextSlice, nextPage, total)
          session.bundlePage = nextPage
          session.bundlePageShown = nextMenu.shown
          reply = nextMenu.text
          break
        }

        const bundleIndex = chosen - offset - 1
        const selected = pageSlice[bundleIndex]
        if (Number.isNaN(chosen) || bundleIndex < 0 || bundleIndex >= shown || !selected) {
          const menu = shopBundleMenu(shopName, pageSlice, page, total)
          session.bundlePageShown = menu.shown
          reply = menu.text
          break
        }

        session.step = 'ENTER_RECIPIENT'
        session.bundleId = selected.id
        session.bundleSize = selected.size
        session.bundlePrice = selected.price
        reply = shopRecipientPrompt()
        break
      }

      // ── ENTER_RECIPIENT ─────────────────────────────────────────────────────
      case 'ENTER_RECIPIENT': {
        if (input === '0') {
          const pg = session.bundlePage ?? 0
          const all = session.bundleCache ?? []
          const backMenu = shopBundleMenu(
            shopName,
            all.slice(pg * PAGE_SIZE, (pg + 1) * PAGE_SIZE),
            pg,
            session.bundleTotal ?? all.length
          )
          session.step = 'SELECT_BUNDLE'
          session.bundlePageShown = backMenu.shown
          reply = backMenu.text
          break
        }

        const local = normalizeGhanaLocal(input)
        if (!isValidLocalGhana(local)) {
          reply = 'Invalid number.\nEnter a valid Ghana\nphone number:\n\n0. Back'
          break
        }

        const { enabled: prefixCheckEnabled, map: prefixMap } = await getPrefixValidationConfig()
        if (prefixCheckEnabled && session.network) {
          const check = validateNetworkPrefix(session.network, local, prefixMap)
          if (!check.ok) {
            reply = `${check.message}\n\nEnter recipient number:\n0. Back`
            break
          }
        }

        session.step = 'ENTER_PAYMENT_PHONE'
        session.recipientPhone = local
        reply = shopPaymentPhonePrompt()
        break
      }

      // ── ENTER_PAYMENT_PHONE (new — no USSD equivalent) ─────────────────────
      case 'ENTER_PAYMENT_PHONE': {
        if (input === '0') {
          deleteAfter = true
          reply = 'Order cancelled.'
          break
        }

        const local = normalizeGhanaLocal(input)
        if (!isValidLocalGhana(local)) {
          reply = shopInvalidPaymentPhoneMenu()
          break
        }

        const paystackProvider = paystackProviderFromPhone(local)
        if (!paystackProvider) {
          reply = shopNoProviderMessage()
          break
        }

        session.step = 'CONFIRM'
        session.paymentPhone = local
        session.paystackProvider = paystackProvider
        reply = shopConfirmMenu(
          shopName,
          session.network!,
          session.bundleSize!,
          session.bundlePrice!,
          session.recipientPhone!,
          local
        )
        break
      }

      // ── CONFIRM ──────────────────────────────────────────────────────────────
      case 'CONFIRM': {
        if (input === '2' || input === '0') {
          deleteAfter = true
          reply = 'Order cancelled.'
          break
        }
        if (input !== '1') {
          reply = shopConfirmMenu(
            shopName,
            session.network!,
            session.bundleSize!,
            session.bundlePrice!,
            session.recipientPhone!,
            session.paymentPhone!
          )
          break
        }

        // Re-check the shop's token balance right before charging — the ENTER_CODE
        // gate only proved >0 tokens existed up to 30 minutes ago (shop-session.ts's
        // TTL), and the balance is a pool shared with USSD, so it can be spent to 0
        // elsewhere while this session sits idle. Without this, a 0-token shop would
        // still get charged AND fulfilled for free (shop-revenue loss).
        const tokenBalance = await fetchShopCodeTokenBalance(session.shopCodeId!)
        if (tokenBalance === null || tokenBalance <= 0) {
          deleteAfter = true
          reply = 'This shop has no sessions left. Please contact the seller.'
          break
        }

        // Re-fetch retail price from DB to prevent stale-session price tampering.
        const verified = await verifyBundlePrice(session.shopId!, session.bundleId!, session.parentShopId)
        if (!verified) {
          deleteAfter = true
          reply = 'This bundle is no longer available. Please send your shop code to start again.'
          break
        }
        const { verifiedPrice, profitAmount, parentProfitAmount } = verified

        if (Math.abs(verifiedPrice - session.bundlePrice!) > 0.01) {
          deleteAfter = true
          reply = `The price has changed to GHS ${verifiedPrice.toFixed(2)}. Please send your shop code to start again.`
          break
        }

        const feePercent = await fetchPaystackFeePercent()
        const fee = Math.round(verifiedPrice * feePercent * 100) / 100
        const chargeAmount = verifiedPrice + fee

        const [customerEmail, shopOwnerEmail] = await Promise.all([
          resolveEmail(from).catch(() => null),
          fetchShopOwnerEmail(session.shopId!).catch(() => null),
        ])

        const orderResult = await createShopBundleOrder({
          shopCodeId: session.shopCodeId!,
          shopId: session.shopId!,
          parentShopId: session.parentShopId ?? null,
          dialingPhone: from,
          recipientPhone: session.recipientPhone!,
          network: session.network!,
          paystackProvider: session.paystackProvider!,
          bundleId: session.bundleId!,
          bundleSize: session.bundleSize!,
          verifiedPrice,
          profitAmount,
          parentProfitAmount,
          chargeAmount,
          shopName: session.shopName ?? null,
          customerEmail: customerEmail ?? null,
          shopOwnerEmail,
          channel: 'whatsapp_shop',
        })

        if ('error' in orderResult) {
          console.error("[WA-SHOP-CONFIRM] Failed to create order:", orderResult.error)
          deleteAfter = true
          reply = 'Sorry, there was an error creating your order. Please try again.'
          break
        }

        const orderId = orderResult.orderId
        const email = customerEmail ?? await resolveEmail(from).catch(() => `${from.replace(/\D/g, '')}@ussd.datagod.com`)

        try {
          const { status } = await chargeMobileMoney({
            email,
            amount: chargeAmount,
            phone: session.paymentPhone!,
            provider: session.paystackProvider as 'mtn' | 'vod' | 'tgo',
            reference: orderId,
            metadata: {
              source: 'whatsapp_shop',
              whatsapp_shop_order_id: orderId,
              recipient_phone: session.recipientPhone,
              network: session.network,
              package_size: session.bundleSize,
              shop_id: session.shopId,
            },
          })

          if (status === 'send_otp') {
            await markOrderOtpRequired('ussd_shop_orders', orderId)
            session.step = 'SUBMIT_OTP'
            session.pendingOrderId = orderId
            session.pendingOrderTable = 'ussd_shop_orders'
            reply = shopOtpMenu()
          } else {
            deleteAfter = true
            reply = shopPaymentSentMenu(session.paymentPhone!)
          }
        } catch (err) {
          console.error("[WA-SHOP-CONFIRM] Charge failed:", err)
          // chargeMobileMoney throws whenever Paystack's HTTP response isn't ok —
          // meaning Paystack never registered the charge, so no charge.failed
          // webhook will ever arrive to reconcile this order. Without this write
          // it would sit at pending/pending forever (no cron covers this table).
          await markOrderFailed('ussd_shop_orders', orderId)
          deleteAfter = true
          reply = 'Sorry, we could not start the payment. Please try again.'
        }
        break
      }

      // ── AIRTIME_ENTER_RECIPIENT ─────────────────────────────────────────────
      case 'AIRTIME_ENTER_RECIPIENT': {
        if (input === '0') {
          session.step = 'SELECT_PRODUCT'
          reply = shopProductMenu(shopName, !(session.dataBlocked === true))
          break
        }

        const local = normalizeGhanaLocal(input)
        if (!isValidLocalGhana(local)) {
          reply = `Invalid number.\n${shopAirtimeRecipientPrompt(shopName)}`
          break
        }

        const network = detectAirtimeNetwork(local)
        if (!network) {
          session.step = 'AIRTIME_SELECT_NETWORK'
          session.airtimeRecipient = local
          reply = shopAirtimeNetworkMenu()
          break
        }

        if (!(await isAirtimeEnabled(network))) {
          reply = `${network} airtime unavailable.\n${shopAirtimeRecipientPrompt(shopName)}`
          break
        }

        const { min, max } = await getAirtimeLimits()
        session.step = 'AIRTIME_ENTER_AMOUNT'
        session.airtimeRecipient = local
        session.airtimeNetwork = network
        reply = shopAirtimeAmountPrompt(network, min, max)
        break
      }

      // ── AIRTIME_SELECT_NETWORK (fallback — recipient prefix wasn't recognised) ─
      case 'AIRTIME_SELECT_NETWORK': {
        if (input === '0') {
          session.step = 'AIRTIME_ENTER_RECIPIENT'
          reply = shopAirtimeRecipientPrompt(shopName)
          break
        }

        const map: Record<string, string> = { '1': 'MTN', '2': 'Telecel', '3': 'AT' }
        const network = map[input]
        if (!network) {
          reply = shopAirtimeNetworkMenu()
          break
        }

        if (!(await isAirtimeEnabled(network))) {
          reply = `${network} airtime unavailable.\n${shopAirtimeNetworkMenu()}`
          break
        }

        const { min, max } = await getAirtimeLimits()
        session.step = 'AIRTIME_ENTER_AMOUNT'
        session.airtimeNetwork = network
        reply = shopAirtimeAmountPrompt(network, min, max)
        break
      }

      // ── AIRTIME_ENTER_AMOUNT ────────────────────────────────────────────────
      case 'AIRTIME_ENTER_AMOUNT': {
        if (input === '0') {
          session.step = 'AIRTIME_ENTER_RECIPIENT'
          reply = shopAirtimeRecipientPrompt(shopName)
          break
        }

        const network = session.airtimeNetwork!
        const amount = parseFloat(input)
        const { min, max } = await getAirtimeLimits()
        if (isNaN(amount) || amount < min || amount > max) {
          reply = `Enter a valid amount.\n${shopAirtimeAmountPrompt(network, min, max)}`
          break
        }

        const { totalFeeRate, merchantCommissionRate } = await shopAirtimeFeeRate(session.shopId!, network)
        const { fee, toDeliver } = splitInclusive(amount, totalFeeRate)
        const commission = parseFloat((toDeliver * merchantCommissionRate / 100).toFixed(2))

        session.step = 'AIRTIME_ENTER_PAYMENT_PHONE'
        session.airtimeAmount = amount
        session.airtimeFee = fee
        session.airtimeToDeliver = toDeliver
        session.airtimeMerchantCommission = commission
        reply = shopPaymentPhonePrompt()
        break
      }

      // ── AIRTIME_ENTER_PAYMENT_PHONE (new — no USSD equivalent) ─────────────
      case 'AIRTIME_ENTER_PAYMENT_PHONE': {
        if (input === '0') {
          deleteAfter = true
          reply = 'Order cancelled.'
          break
        }

        const local = normalizeGhanaLocal(input)
        if (!isValidLocalGhana(local)) {
          reply = shopInvalidPaymentPhoneMenu()
          break
        }

        const paystackProvider = paystackProviderFromPhone(local)
        if (!paystackProvider) {
          reply = shopNoProviderMessage()
          break
        }

        session.step = 'AIRTIME_CONFIRM'
        session.paymentPhone = local
        session.paystackProvider = paystackProvider
        reply = shopAirtimeConfirmMenu(
          shopName,
          session.airtimeNetwork!,
          session.airtimeRecipient!,
          session.airtimeAmount!,
          session.airtimeToDeliver!,
          local
        )
        break
      }

      // ── AIRTIME_CONFIRM ─────────────────────────────────────────────────────
      case 'AIRTIME_CONFIRM': {
        if (input === '2' || input === '0') {
          deleteAfter = true
          reply = 'Order cancelled.'
          break
        }
        if (input !== '1') {
          reply = shopAirtimeConfirmMenu(
            shopName,
            session.airtimeNetwork!,
            session.airtimeRecipient!,
            session.airtimeAmount!,
            session.airtimeToDeliver!,
            session.paymentPhone!
          )
          break
        }

        // Same anti-race token recheck as Data's CONFIRM — see the comment on
        // fetchShopCodeTokenBalance above.
        const tokenBalance = await fetchShopCodeTokenBalance(session.shopCodeId!)
        if (tokenBalance === null || tokenBalance <= 0) {
          deleteAfter = true
          reply = 'This shop has no sessions left. Please contact the seller.'
          break
        }

        const network = session.airtimeNetwork!
        const amount = session.airtimeAmount!

        // Re-verify settings server-side (mirrors USSD's handleShopAirtimeConfirm) —
        // do NOT trust the session's cached airtimeFee/airtimeToDeliver/
        // airtimeMerchantCommission for the actual charge; recompute fresh below.
        if (!(await isAirtimeEnabled(network))) {
          deleteAfter = true
          reply = `${network} airtime is no longer available. Please send your shop code to start again.`
          break
        }
        const { min, max } = await getAirtimeLimits()
        if (amount < min || amount > max) {
          deleteAfter = true
          reply = `Amount must be GHS ${min}-${max}. Please send your shop code to start again.`
          break
        }

        const { totalFeeRate, merchantCommissionRate } = await shopAirtimeFeeRate(session.shopId!, network)
        const { fee, toDeliver } = splitInclusive(amount, totalFeeRate)
        const commission = parseFloat((toDeliver * merchantCommissionRate / 100).toFixed(2))

        const referenceCode = secureReference("AT", 2, 3)
        const customerEmail = await resolveEmail(from).catch(() => null)

        const orderResult = await createShopAirtimeOrder({
          referenceCode,
          network,
          beneficiaryPhone: session.airtimeRecipient!,
          airtimeAmount: toDeliver,
          feeAmount: fee,
          totalPaid: amount,
          shopId: session.shopId!,
          merchantCommission: commission,
          dialingPhone: from,
          channel: 'whatsapp_shop',
          customerName: 'WhatsApp Customer',
          customerEmail: customerEmail ?? null,
        })

        if ('error' in orderResult) {
          console.error("[WA-SHOP-AIRTIME-CONFIRM] Failed to create order:", orderResult.error)
          deleteAfter = true
          reply = 'Sorry, there was an error creating your order. Please try again.'
          break
        }

        const orderId = orderResult.orderId
        const email = customerEmail ?? await resolveEmail(from).catch(() => `${from.replace(/\D/g, '')}@ussd.datagod.com`)

        try {
          const { status } = await chargeMobileMoney({
            email,
            amount,
            phone: session.paymentPhone!,
            provider: session.paystackProvider as 'mtn' | 'vod' | 'tgo',
            reference: orderId,
            metadata: {
              source: 'whatsapp_shop_airtime',
              airtime_order_id: orderId,
              recipient_phone: session.airtimeRecipient,
              network,
              shop_id: session.shopId,
            },
          })

          if (status === 'send_otp') {
            await markOrderOtpRequired('airtime_orders', orderId)
            session.step = 'SUBMIT_OTP'
            session.pendingOrderId = orderId
            session.pendingOrderTable = 'airtime_orders'
            reply = shopOtpMenu()
          } else {
            deleteAfter = true
            reply = shopPaymentSentMenu(session.paymentPhone!)
          }
        } catch (err) {
          console.error("[WA-SHOP-AIRTIME-CONFIRM] Charge failed:", err)
          await markOrderFailed('airtime_orders', orderId)
          deleteAfter = true
          reply = 'Sorry, we could not start the payment. Please try again.'
        }
        break
      }

      // ── RC_SELECT_BOARD ─────────────────────────────────────────────────────
      case 'RC_SELECT_BOARD': {
        const options = session.rcBoardOptions ?? []
        if (input === '0') {
          session.step = 'SELECT_PRODUCT'
          reply = shopProductMenu(shopName, !(session.dataBlocked === true))
          break
        }

        const idx = parseInt(input, 10) - 1
        const board = Number.isNaN(idx) ? undefined : options[idx]
        if (!board) {
          reply = shopRcBoardMenu(shopName, options)
          break
        }

        const [avail, max, bulkHint] = await Promise.all([
          getAvailableCount(board as ExamBoard),
          getMaxQuantity(),
          getRCBulkHint(board as ExamBoard),
        ])
        let bulkForMenu: { minQty: number; unitPrice: number } | null = null
        if (bulkHint) {
          const bulkPricing = await calculateRCPrice({ examBoard: board as ExamBoard, quantity: bulkHint.minQty, shopId: session.shopId, applyBulk: true })
          if (bulkPricing.bulkApplied) bulkForMenu = { minQty: bulkHint.minQty, unitPrice: bulkPricing.unitPrice }
        }

        session.step = 'RC_ENTER_QTY'
        session.rcBoard = board
        reply = shopRcQtyPrompt(board, avail, max, bulkForMenu)
        break
      }

      // ── RC_ENTER_QTY ─────────────────────────────────────────────────────────
      case 'RC_ENTER_QTY': {
        if (input === '0') {
          const boards = await buildRcBoardOptions()
          session.step = 'RC_SELECT_BOARD'
          session.rcBoardOptions = boards
          reply = shopRcBoardMenu(shopName, boards)
          break
        }

        const board = session.rcBoard! as ExamBoard
        const [avail, max, bulkHint] = await Promise.all([
          getAvailableCount(board),
          getMaxQuantity(),
          getRCBulkHint(board),
        ])
        let bulkForMenu: { minQty: number; unitPrice: number } | null = null
        if (bulkHint) {
          const bulkPricing = await calculateRCPrice({ examBoard: board, quantity: bulkHint.minQty, shopId: session.shopId, applyBulk: true })
          if (bulkPricing.bulkApplied) bulkForMenu = { minQty: bulkHint.minQty, unitPrice: bulkPricing.unitPrice }
        }
        const cap = Math.min(avail, max)
        const qty = parseInt(input, 10)
        if (Number.isNaN(qty) || qty < 1 || qty > cap) {
          reply = `Enter a valid quantity.\n${shopRcQtyPrompt(board, avail, max, bulkForMenu)}`
          break
        }

        const pricing = await calculateRCPrice({ examBoard: board, quantity: qty, shopId: session.shopId, applyBulk: true })

        session.step = 'RC_ENTER_PAYMENT_PHONE'
        session.rcQty = qty
        session.rcUnitPrice = pricing.unitPrice
        session.rcTotal = pricing.totalPaid
        session.rcMerchantCommission = pricing.merchantCommission
        reply = shopPaymentPhonePrompt()
        break
      }

      // ── RC_ENTER_PAYMENT_PHONE (new — no USSD equivalent) ───────────────────
      case 'RC_ENTER_PAYMENT_PHONE': {
        if (input === '0') {
          deleteAfter = true
          reply = 'Order cancelled.'
          break
        }

        const local = normalizeGhanaLocal(input)
        if (!isValidLocalGhana(local)) {
          reply = shopInvalidPaymentPhoneMenu()
          break
        }

        const paystackProvider = paystackProviderFromPhone(local)
        if (!paystackProvider) {
          reply = shopNoProviderMessage()
          break
        }

        session.step = 'RC_CONFIRM'
        session.paymentPhone = local
        session.paystackProvider = paystackProvider
        reply = shopRcConfirmMenu(shopName, session.rcBoard!, session.rcQty!, session.rcTotal!, local)
        break
      }

      // ── RC_CONFIRM ───────────────────────────────────────────────────────────
      case 'RC_CONFIRM': {
        if (input === '2' || input === '0') {
          deleteAfter = true
          reply = 'Order cancelled.'
          break
        }
        if (input !== '1') {
          reply = shopRcConfirmMenu(shopName, session.rcBoard!, session.rcQty!, session.rcTotal!, session.paymentPhone!)
          break
        }

        // Same anti-race token recheck as Data's CONFIRM — see the comment on
        // fetchShopCodeTokenBalance above.
        const tokenBalance = await fetchShopCodeTokenBalance(session.shopCodeId!)
        if (tokenBalance === null || tokenBalance <= 0) {
          deleteAfter = true
          reply = 'This shop has no sessions left. Please contact the seller.'
          break
        }

        const board = session.rcBoard! as ExamBoard
        const qty = session.rcQty!

        // Re-verify availability + price server-side (stale-session guard) —
        // mirrors USSD's handleShopRcConfirm; do NOT trust the session's cached
        // rcUnitPrice/rcTotal/rcMerchantCommission for the actual charge.
        const [enabled, avail] = await Promise.all([isExamBoardEnabled(board), getAvailableCount(board)])
        if (!enabled || avail < qty) {
          deleteAfter = true
          reply = `${board} vouchers are no longer available in that quantity. Please send your shop code to start again.`
          break
        }
        const pricing = await calculateRCPrice({ examBoard: board, quantity: qty, shopId: session.shopId, applyBulk: true })

        const referenceCode = secureReference("RC", 2, 3)
        const localCustomerPhone = normalizeGhanaLocal(from)
        const customerEmail = await resolveEmail(from).catch(() => null)

        const orderResult = await createShopRcOrder({
          referenceCode,
          examBoard: board,
          quantity: qty,
          customerPhone: localCustomerPhone,
          unitPrice: pricing.unitPrice,
          totalPaid: pricing.totalPaid,
          shopId: session.shopId!,
          merchantCommission: pricing.merchantCommission,
          dialingPhone: from,
          channel: 'whatsapp_shop',
          customerName: 'WhatsApp Customer',
          customerEmail: customerEmail ?? null,
        })

        if ('error' in orderResult) {
          console.error("[WA-SHOP-RC-CONFIRM] Failed to create order:", orderResult.error)
          deleteAfter = true
          reply = 'Sorry, there was an error creating your order. Please try again.'
          break
        }

        const orderId = orderResult.orderId
        const email = customerEmail ?? await resolveEmail(from).catch(() => `${from.replace(/\D/g, '')}@ussd.datagod.com`)

        try {
          const { status } = await chargeMobileMoney({
            email,
            amount: pricing.totalPaid,
            phone: session.paymentPhone!,
            provider: session.paystackProvider as 'mtn' | 'vod' | 'tgo',
            reference: orderId,
            metadata: {
              source: 'whatsapp_shop_results_checker',
              results_checker_order_id: orderId,
              exam_board: board,
              quantity: qty,
              shop_id: session.shopId,
            },
          })

          if (status === 'send_otp') {
            await markOrderOtpRequired('results_checker_orders', orderId)
            session.step = 'SUBMIT_OTP'
            session.pendingOrderId = orderId
            session.pendingOrderTable = 'results_checker_orders'
            reply = shopOtpMenu()
          } else {
            deleteAfter = true
            reply = shopPaymentSentMenu(session.paymentPhone!)
          }
        } catch (err) {
          console.error("[WA-SHOP-RC-CONFIRM] Charge failed:", err)
          await markOrderFailed('results_checker_orders', orderId)
          deleteAfter = true
          reply = 'Sorry, we could not start the payment. Please try again.'
        }
        break
      }

      // ── SUBMIT_OTP ───────────────────────────────────────────────────────────
      case 'SUBMIT_OTP': {
        // Every CONFIRM branch (Data/Airtime/RC) sets pendingOrderTable alongside
        // pendingOrderId before transitioning here — the fallback only guards
        // against a theoretically corrupted/older session.
        const table: ShopOrderTable = session.pendingOrderTable ?? 'ussd_shop_orders'

        if (input === '0') {
          // Mirrors USSD's handleSubmitOtp/handleOtpSubmit: mark the order failed
          // rather than leaving it stuck at pending/pending — the only automated
          // reconciliation (verify-pending-payments cron) never queries these
          // tables, and an abandoned OTP isn't guaranteed to produce a Paystack
          // charge.failed webhook event either.
          await markOrderFailed(table, session.pendingOrderId!)
          deleteAfter = true
          reply = 'Order cancelled.'
          break
        }

        try {
          const { status } = await submitOtp(session.pendingOrderId!, input)
          // Paystack rejected the OTP (wrong/expired code) — mirror USSD's
          // handleSubmitOtp/handleOtpSubmit, which marks the order failed here
          // too, not just on a thrown error.
          if (status === 'failed') {
            await markOrderFailed(table, session.pendingOrderId!)
          }
        } catch (err) {
          console.error("[WA-SHOP-OTP] submitOtp error:", err)
          await markOrderFailed(table, session.pendingOrderId!)
        }
        // One-shot, like USSD's handleSubmitOtp — no retry within the same
        // session. Actual success/failure surfaces later via SMS/webhook.
        deleteAfter = true
        reply = 'Check your phone for a MoMo authorization prompt and approve to complete payment.'
        break
      }

      default: {
        // Unknown/unreached step (e.g. a corrupted session) — reset rather than
        // get stuck.
        deleteAfter = true
        reply = 'Session error. Please send your shop code to start again.'
      }
    }
  }

  const wamid = await sendWhatsAppText(from, reply, process.env.WHATSAPP_SHOP_PHONE_NUMBER_ID)
  await logMessage(from, "outbound", reply, wamid)

  if (skipPersist) return reply
  if (deleteAfter) {
    await deleteSession(from)
  } else if (session) {
    await setSession(from, session)
  }
  return reply
}

// Pure predicate for the webhook route's phone_number_id branch, pulled out
// so it's unit-testable without mocking the rest of processInbound (which
// touches Supabase, session state, the AI loop, etc.). Mirrors exactly what
// the route checks: shop routing only fires when the env var is configured
// AND matches the phone_number_id Meta sent for this webhook. Unset/mismatch
// -> false, so the caller falls through to the existing main bot/AI flow.
export function isShopWhatsAppNumber(
  receivingPhoneNumberId: string | undefined,
  shopPhoneNumberId: string | undefined = process.env.WHATSAPP_SHOP_PHONE_NUMBER_ID
): boolean {
  return !!shopPhoneNumberId && receivingPhoneNumberId === shopPhoneNumberId
}
