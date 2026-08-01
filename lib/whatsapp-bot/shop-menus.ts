// lib/whatsapp-bot/shop-menus.ts
//
// Pure presentation layer for the WhatsApp shop bot — mirrors lib/ussd-shop/menus.ts's
// content/business logic (shop name, network options, bundle sizes/prices, confirmation
// details, etc.) but renders plain WhatsApp text instead of USSD gateway responses:
//   - No cont()/end() wrapper — WhatsApp has no ussdServiceOp, just send the string.
//   - No truncate()/SCREEN_LIMIT(160) — that's a USSD carrier-screen constraint only.
//   - No gsm7() ASCII-stripping — WhatsApp is UTF-8, not GSM7-encoded over a carrier link.
//   - shopBundleMenu() keeps pagination (WaShopSession retains bundlePage/bundleCache/etc,
//     same shape as USSDShopSession) but pages by a fixed count instead of the USSD
//     version's byte-budget-fitting loop, since there's no 160-char screen to fit into.
//   - Params named `paymentPhone` instead of the USSD version's `dialingPhone` — WhatsApp
//     has no live dialing session; the MoMo number is explicitly asked for and stored in
//     WaShopSession.paymentPhone (see shop-types.ts).
//
// Naming: every export here is `shop`-prefixed (shopProductMenu, shopNetworkMenu, ...).
// lib/ussd-shop/menus.ts exports several functions with the SAME base names (networkMenu,
// confirmMenu, bundleMenu, recipientPrompt, otpMenu, productMenu) — without the prefix,
// a future file that imports from both modules (e.g. shop-router.ts, which will need
// business logic from lib/ussd-shop/handlers/* AND renderers from here) risks a silent
// copy-paste mix-up that still compiles cleanly but ships USSD-truncated/"Redial"-worded
// content in a WhatsApp reply. The `shop` prefix was already used for the Airtime/RC
// group below (shopAirtimeNetworkMenu, shopRcBoardMenu, ...); this extends it to the
// Data-bundle group for full self-consistency.
//
// Style precedent: lib/whatsapp-bot/router.ts reuses lib/ussd/menus.ts's own menu
// functions (mainMenu, networkMenu, waConfirmMenu, ...) completely verbatim for
// WhatsApp — same numbered "1./2./0. Back" options, no emoji, no reflowed prose. This
// file follows that same established convention: content ported near-verbatim from the
// USSD shop menus, no new visual style invented.
//
// sortNetworks: still lives in lib/ussd-shop/menus.ts (grepped the codebase — it has not
// moved into lib/shop-commerce/pricing.ts). Imported and reused here rather than
// duplicated.
import { sortNetworks } from "@/lib/ussd-shop/menus"
import { WaShopBundleOption } from "./shop-types"

export { sortNetworks }

export const PAGE_SIZE = 5

// ── Shop entry ─────────────────────────────────────────────────────────────────
export function shopEnterCodeMenu(): string {
  return 'Welcome to DataGod\nEnter shop code:\n\n0. Exit'
}

export function shopInvalidCodeMenu(reason: string): string {
  return `${reason}\n\nEnter shop code:\n\n0. Exit`
}

export function shopProductMenu(shopName: string, showData = true): string {
  if (showData) {
    return `${shopName}\nWhat to buy?\n1. Data Bundle\n2. Airtime\n3. Results Checker\n4. Check My Results\n0. Exit`
  }
  return `${shopName}\nWhat to buy?\n1. Airtime\n2. Results Checker\n3. Check My Results\n0. Exit`
}

// ── Shop Data Bundle ──────────────────────────────────────────────────────────
export function shopNetworkMenu(shopName: string, networks: string[]): string {
  const sorted = sortNetworks(networks)
  const lines = sorted.map((n, i) => `${i + 1}. ${n}`)
  lines.push('0. Back')
  return `${shopName}\nSelect Network:\n` + lines.join('\n')
}

// `bundles` is the already-paginated slice for this page (caller slices bundleCache by
// PAGE_SIZE before calling, same contract as lib/ussd-shop/menus.ts's bundleMenu — see
// lib/ussd-shop/handlers/bundles.ts's handleSelectNetwork/handleSelectBundle for the
// paging math this mirrors). Returns `shown` so the caller can persist bundlePageShown.
export function shopBundleMenu(
  shopName: string,
  bundles: WaShopBundleOption[],
  page: number,
  total: number
): { text: string; shown: number } {
  const offset = page * PAGE_SIZE
  const header = `${shopName}\nSelect Bundle:\n`
  const lines = bundles.map((b, i) => `${offset + i + 1}. ${b.size} - GHS ${b.price.toFixed(2)}`)
  const shown = bundles.length
  const hasMore = offset + shown < total
  if (hasMore) lines.push(`${offset + shown + 1}. More...`)
  lines.push('0. Back')
  return { text: header + lines.join('\n'), shown }
}

export function shopRecipientPrompt(): string {
  return 'Enter recipient number\n(who gets the data):\n\n0. Back'
}

// WhatsApp has no live dialing session to infer a payment number from (unlike USSD,
// where the caller's own line is charged) — so the bot must explicitly ask.
// KEEP IN SYNC: this wording is duplicated (not shared) with lib/whatsapp-bot/router.ts's
// 11 inline WA_ENTER_PAYMENT_PHONE-related sends (see e.g. router.ts:303). If that
// wording changes, update here too.
export function shopPaymentPhonePrompt(): string {
  return 'Enter MoMo number to charge:\n(e.g. 0244123456)\n\n0. Cancel'
}

// KEEP IN SYNC: mirrors the invalid-number wording inlined in
// lib/whatsapp-bot/router.ts's handleWaEnterPaymentPhone (see router.ts:600). If that
// wording changes, update here too.
export function shopInvalidPaymentPhoneMenu(): string {
  return 'Invalid number.\nEnter a valid Ghana\nMoMo number:\n(e.g. 0244123456)\n\n0. Cancel'
}

export function shopConfirmMenu(
  shopName: string,
  network: string,
  size: string,
  price: number,
  recipient: string,
  paymentPhone: string
): string {
  const localPayment = formatLocal(paymentPhone)
  const localRecipient = formatLocal(recipient)
  return (
    `${shopName}\n` +
    `${size} ${network}\n` +
    `To: ${localRecipient}\n` +
    `GHS ${price.toFixed(2)} from\n${localPayment}\n\n` +
    `1. Pay now\n2. Cancel`
  )
}

// Adapts the USSD shop's paymentSentMenu — swaps the USSD-only "Redial and enter the
// code" instruction for WhatsApp-appropriate wording.
// KEEP IN SYNC: this mirrors the same substitution lib/whatsapp-bot/router.ts's
// fixWaMomoMsg() makes at runtime to the main bot's USSD-derived messages (router.ts:44-48).
// The two are duplicated, not shared — if fixWaMomoMsg()'s replacement text changes,
// update here too.
export function shopPaymentSentMenu(localPhone: string): string {
  return `MoMo prompt sent to ${localPhone}. Approve to complete.\n\nIf you receive an OTP code, reply here with it.`
}

export function shopOtpMenu(): string {
  return `Pending payment.\nEnter the OTP sent\nto your number to\ncomplete payment:\n\n0. Cancel`
}

// ── Shop Airtime ──────────────────────────────────────────────────────────────
export function shopAirtimeRecipientPrompt(shopName: string): string {
  return `${shopName}\nBuy Airtime\nEnter recipient number:\n\n0. Back`
}

export function shopAirtimeNetworkMenu(): string {
  return 'Select Network:\n1. MTN\n2. Telecel\n3. AirtelTigo\n\n0. Back'
}

export function shopAirtimeAmountPrompt(network: string, min: number, max: number): string {
  return `${network} Airtime\nEnter amount to pay\n(GHS ${min} - ${max}):\n\n0. Back`
}

export function shopAirtimeConfirmMenu(
  shopName: string,
  network: string,
  recipient: string,
  pay: number,
  get: number,
  paymentPhone: string
): string {
  return (
    `${shopName}\n` +
    `${network} to ${formatLocal(recipient)}\n` +
    `Pay GHS ${pay.toFixed(2)}\n` +
    `Get GHS ${get.toFixed(2)}\n` +
    `from ${formatLocal(paymentPhone)}\n\n` +
    `1. Pay now\n2. Cancel`
  )
}

// ── Shop Results Checker ──────────────────────────────────────────────────────
export function shopRcBoardMenu(shopName: string, boards: string[]): string {
  const lines = boards.map((b, i) => `${i + 1}. ${b}`)
  lines.push('0. Back')
  return `${shopName}\nSelect exam:\n` + lines.join('\n')
}

export function shopRcQtyPrompt(
  board: string,
  available: number,
  max: number,
  bulk?: { minQty: number; unitPrice: number } | null
): string {
  const cap = Math.min(available, max)
  const hint = bulk ? `\nBuy ${bulk.minQty}+ for GHS ${bulk.unitPrice.toFixed(2)}/ea` : ''
  return `${board} Checker\nHow many vouchers?\n(1 - ${cap}):${hint}\n\n0. Back`
}

export function shopRcConfirmMenu(
  shopName: string,
  board: string,
  qty: number,
  total: number,
  paymentPhone: string
): string {
  return (
    `${shopName}\n` +
    `${board} x ${qty}\n` +
    `GHS ${total.toFixed(2)} from\n${formatLocal(paymentPhone)}\n` +
    `PIN(s) sent by SMS\n\n` +
    `1. Pay now\n2. Cancel`
  )
}

// ── Shop Check My Results (Datagod checks on the customer's behalf) ──────────
export function shopRcCheckBoardMenu(shopName: string, boards: string[]): string {
  const lines = boards.map((b, i) => `${i + 1}. ${b}`)
  lines.push('0. Back')
  return `${shopName}\nCheck My Results\nSelect exam board:\n` + lines.join('\n')
}

export function shopRcCheckCandidateTypeMenu(): string {
  return 'Candidate Type:\n1. School\n2. Private\n\n0. Back'
}

export function shopRcCheckModeMenu(comboTotal: number, ownFee: number): string {
  return (
    `How to pay?\n` +
    `1. Buy voucher + check\n   GHS ${comboTotal.toFixed(2)}\n` +
    `2. I have a voucher\n   GHS ${ownFee.toFixed(2)}\n\n` +
    `0. Back`
  )
}

export function shopRcCheckVoucherPrompt(): string {
  return 'Enter voucher PIN\nand serial number:\n(PIN/Serial)\ne.g. 1234/567890\n\n0. Back'
}

export function shopRcCheckIndexPrompt(): string {
  return 'Enter your index number:\n(10 digits e.g. 0070202043)\n\n0. Back'
}

export function shopRcCheckYearPrompt(): string {
  return 'Enter exam year:\n(e.g. 2024)\n\n0. Back'
}

export function shopRcCheckDobPrompt(): string {
  return 'Enter date of birth:\n(DD/MM/YYYY)\ne.g. 15/06/2008\n\n0. Back'
}

export function shopRcCheckConfirmMenu(
  shopName: string,
  board: string,
  candidateType: 'school' | 'private',
  indexNo: string,
  year: number,
  dob: string,
  mode: 'combo' | 'own_voucher',
  amount: number,
  paymentPhone: string
): string {
  const boardLine = `${board} (${candidateType === 'school' ? 'School' : 'Private'})`
  const detail = mode === 'combo' ? 'Voucher + check' : 'Check only'
  return (
    `${shopName}\n` +
    `${boardLine}\n` +
    `Index: ${indexNo}\nYear: ${year}\nDOB: ${dob}\n` +
    `${detail}\n` +
    `GHS ${amount.toFixed(2)} from\n${formatLocal(paymentPhone)}\n\n` +
    `1. Pay now\n2. Cancel`
  )
}

function formatLocal(phone: string): string {
  if (phone.startsWith('+233')) return '0' + phone.slice(4)
  if (phone.startsWith('233')) return '0' + phone.slice(3)
  return phone
}
