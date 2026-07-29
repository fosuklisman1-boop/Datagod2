import { createClient } from "@supabase/supabase-js"
import { sendWhatsAppText } from "./send"
import { logMessage } from "./log-message"
import { getSession, setSession, deleteSession } from "./shop-session"
import {
  shopProductMenu, shopNetworkMenu, shopBundleMenu, shopRecipientPrompt,
  shopPaymentPhonePrompt, shopInvalidPaymentPhoneMenu, shopConfirmMenu,
  shopPaymentSentMenu, shopOtpMenu, shopInvalidCodeMenu, sortNetworks, PAGE_SIZE,
} from "./shop-menus"
import { resolveShopCode, fetchShopNetworks } from "@/lib/shop-commerce/shop-code"
import { fetchShopBundles, verifyBundlePrice } from "@/lib/shop-commerce/pricing"
import { createShopBundleOrder } from "@/lib/shop-commerce/orders"
import { chargeMobileMoney, submitOtp } from "@/lib/paystack"
import { paystackProviderFromPhone } from "@/lib/ussd/paystack-provider"
import { validateNetworkPrefix } from "@/lib/phone-format"
import { getPrefixValidationConfig } from "@/lib/network-prefix-config"
import { resolveEmail } from "@/lib/ussd/resolve-email"

// Handles inbound messages that arrived on the dedicated shop WhatsApp number
// (identified by phone_number_id in the webhook payload, wired in
// app/api/whatsapp/webhook/route.ts). Full Data-bundle purchase state machine —
// mirrors lib/ussd-shop/router.ts + handlers/bundles.ts's control flow, but
// rendered as WhatsApp text (lib/whatsapp-bot/shop-menus.ts) and persisted via
// lib/whatsapp-bot/shop-session.ts instead of the USSD dial-session. Airtime and
// Results Checker product choices are Task 3.4's job — they reply "Coming soon"
// here and stay on the product menu.
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
    .single()
  return (data?.paystack_fee_percentage ?? 3.0) / 100
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

export async function shopWaRouter(from: string, text: string, inboundMsgId: string | null): Promise<void> {
  await logMessage(from, "inbound", text, inboundMsgId)

  const input = text.trim()
  let session = await getSession(from)
  let reply: string
  let deleteAfter = false
  // Set only for the "no session, code didn't resolve" branch — nothing was ever
  // created, so there's nothing to persist or delete; the next message retries.
  let skipPersist = false

  if (!session) {
    const resolved = await resolveShopCode(input)

    if (!resolved) {
      reply = shopInvalidCodeMenu('Invalid shop code. Please check and try again.')
      skipPersist = true
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
    }
  } else {
    const shopName = session.shopName ?? 'Shop'

    switch (session.step) {
      // ── SELECT_PRODUCT ──────────────────────────────────────────────────────
      case 'SELECT_PRODUCT': {
        const dataBlocked = session.dataBlocked === true

        if (dataBlocked) {
          // Renumbered menu (no Data option at all): 1=Airtime, 2=Results Checker.
          if (input === '1' || input === '2') {
            reply = `Coming soon.\n\n${shopProductMenu(shopName, false)}`
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
        } else if (input === '2' || input === '3') {
          // Airtime / Results Checker — Task 3.4's job. Stay put.
          reply = `Coming soon.\n\n${shopProductMenu(shopName)}`
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
          reply = "Payment isn't available for that number.\nEnter a different MoMo number:\n(e.g. 0244123456)\n\n0. Cancel"
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
            session.step = 'SUBMIT_OTP'
            session.pendingOrderId = orderId
            reply = shopOtpMenu()
          } else {
            deleteAfter = true
            reply = shopPaymentSentMenu(session.paymentPhone!)
          }
        } catch (err) {
          console.error("[WA-SHOP-CONFIRM] Charge failed:", err)
          deleteAfter = true
          reply = 'Sorry, we could not start the payment. Please try again.'
        }
        break
      }

      // ── SUBMIT_OTP ───────────────────────────────────────────────────────────
      case 'SUBMIT_OTP': {
        if (input === '0') {
          // Mirrors USSD's handleSubmitOtp: mark the order failed rather than
          // leaving it stuck at pending/pending — the only automated
          // reconciliation (verify-pending-payments cron) never queries
          // ussd_shop_orders, and an abandoned OTP isn't guaranteed to produce
          // a Paystack charge.failed webhook event either.
          try {
            await supabase
              .from("ussd_shop_orders")
              .update({ order_status: 'failed', payment_status: 'failed', updated_at: new Date().toISOString() })
              .eq("id", session.pendingOrderId)
          } catch (err) {
            console.error("[WA-SHOP-OTP] failed to mark order failed on cancel:", err)
          }
          deleteAfter = true
          reply = 'Order cancelled.'
          break
        }

        try {
          await submitOtp(session.pendingOrderId!, input)
        } catch (err) {
          console.error("[WA-SHOP-OTP] submitOtp error:", err)
        }
        // One-shot, like USSD's handleSubmitOtp — no retry within the same
        // session. Actual success/failure surfaces later via SMS/webhook.
        deleteAfter = true
        reply = 'Check your phone for a MoMo authorization prompt and approve to complete payment.'
        break
      }

      default: {
        // Unknown/unreached step (e.g. an Airtime/RC step from a future build,
        // or a corrupted session) — reset rather than get stuck.
        deleteAfter = true
        reply = 'Session error. Please send your shop code to start again.'
      }
    }
  }

  const wamid = await sendWhatsAppText(from, reply, process.env.WHATSAPP_SHOP_PHONE_NUMBER_ID)
  await logMessage(from, "outbound", reply, wamid)

  if (skipPersist) return
  if (deleteAfter) {
    await deleteSession(from)
  } else if (session) {
    await setSession(from, session)
  }
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
