import { UzoResponse, BundleOption } from "./types"

const PAGE_SIZE = 5
const SCREEN_LIMIT = 160 // safe character limit per USSD screen

export function cont(message: string): UzoResponse {
  return { message: truncate(message), ussdServiceOp: 2 }
}

export function end(message: string): UzoResponse {
  return { message: truncate(message), ussdServiceOp: 17 }
}

function truncate(msg: string): string {
  return msg.length > SCREEN_LIMIT ? msg.slice(0, SCREEN_LIMIT - 3) + '...' : msg
}

export function mainMenu(): string {
  return 'Welcome to Datagod\n1. Buy Data Bundle\n2. AFA Registration\n3. Buy Airtime\n4. Results Checker\n0. Exit'
}

// ── Airtime ───────────────────────────────────────────────────────────────────
export function airtimeRecipientPrompt(): string {
  return 'Buy Airtime\nEnter recipient number\n(who gets the airtime):\n\n0. Back'
}

export function airtimeNetworkMenu(): string {
  return 'Select Network:\n1. MTN\n2. Telecel\n3. AirtelTigo\n\n0. Back'
}

export function airtimeAmountPrompt(network: string, min: number, max: number): string {
  return `${network} Airtime\nEnter amount to pay\n(GHS ${min} - ${max}):\n\n0. Back`
}

export function airtimeConfirmMenu(network: string, recipient: string, amountPay: number, amountGet: number, dialingPhone: string): string {
  return (
    `Confirm Airtime\n` +
    `${network} to ${formatLocal(recipient)}\n` +
    `You pay GHS ${amountPay.toFixed(2)}\n` +
    `They get GHS ${amountGet.toFixed(2)}\n` +
    `from ${formatLocal(dialingPhone)}\n\n` +
    `1. Pay now\n2. Cancel`
  )
}

export function airtimePaymentMethodMenu(amount: number, balance: number): string {
  return (
    `Pay GHS ${amount.toFixed(2)}\n` +
    `1. Datagod Wallet\n` +
    `   (GHS ${balance.toFixed(2)})\n` +
    `2. MoMo prompt\n` +
    `0. Cancel`
  )
}

// ── Results Checker ───────────────────────────────────────────────────────────
export function rcBoardMenu(boards: string[]): string {
  const lines = boards.map((b, i) => `${i + 1}. ${b}`)
  lines.push('0. Back')
  return 'Results Checker\nSelect exam:\n' + lines.join('\n')
}

export function rcQtyPrompt(board: string, available: number, max: number): string {
  const cap = Math.min(available, max)
  return `${board} Checker\nHow many vouchers?\n(1 - ${cap}):\n\n0. Back`
}

export function rcConfirmMenu(board: string, qty: number, total: number, dialingPhone: string): string {
  return (
    `Confirm Vouchers\n` +
    `${board} x ${qty}\n` +
    `GHS ${total.toFixed(2)} from\n${formatLocal(dialingPhone)}\n` +
    `PIN(s) sent by SMS\n\n` +
    `1. Pay now\n2. Cancel`
  )
}

export function rcPaymentMethodMenu(total: number, balance: number): string {
  return (
    `Pay GHS ${total.toFixed(2)}\n` +
    `1. Datagod Wallet\n` +
    `   (GHS ${balance.toFixed(2)})\n` +
    `2. MoMo prompt\n` +
    `0. Cancel`
  )
}

export function afaEnterNamePrompt(): string {
  return 'AFA Registration\nEnter your full\nname:\n\n0. Back'
}

export function afaEnterCardPrompt(): string {
  return 'Enter your Ghana\nCard Number:\n(e.g. GHA-12345-6)\n\n0. Back'
}

export function afaEnterLocationPrompt(): string {
  return 'Enter your city\nor town:\n(e.g. Accra)\n\n0. Back'
}

export function afaEnterRegionPrompt(): string {
  return 'Enter your region:\n(e.g. Ashanti,\nGreater Accra)\n\n0. Back'
}

export function afaConfirmMenu(name: string, card: string, price: number, localPhone: string): string {
  return (
    `AFA Registration\n` +
    `${name}\n` +
    `Card: ${card}\n` +
    `GHS ${price.toFixed(2)} from\n` +
    `${localPhone}\n\n` +
    `1. Pay now\n2. Cancel`
  )
}

export function networkMenu(): string {
  return 'Select Network:\n1. MTN\n2. Telecel\n3. AirtelTigo\n4. AT-iShare\n0. Back'
}

export function bundleMenu(bundles: BundleOption[], page: number, total: number): string {
  const offset = page * PAGE_SIZE
  const lines = bundles.map((b, i) => `${offset + i + 1}. ${b.size} - GHS ${b.price.toFixed(2)}`)
  const hasMore = offset + bundles.length < total
  if (hasMore) lines.push(`${offset + bundles.length + 1}. More...`)
  lines.push('0. Back')
  return 'Select Bundle:\n' + lines.join('\n')
}

export function paymentMethodMenu(amount: number, balance: number): string {
  return (
    `Pay GHS ${amount.toFixed(2)}\n` +
    `1. Datagod Wallet\n` +
    `   (GHS ${balance.toFixed(2)})\n` +
    `2. MoMo prompt\n` +
    `0. Cancel`
  )
}

export function recipientPrompt(): string {
  return 'Enter recipient number\n(who gets the data):\n\n0. Back'
}

export function confirmMenu(network: string, size: string, price: number, recipient: string, dialingPhone: string): string {
  const localDialing = formatLocal(dialingPhone)
  const localRecipient = formatLocal(recipient)
  return (
    `Confirm:\n` +
    `${size} ${network}\n` +
    `To: ${localRecipient}\n` +
    `GHS ${price.toFixed(2)} from\n${localDialing}\n\n` +
    `1. Pay now\n2. Cancel`
  )
}

export function otpPrompt(): string {
  return 'Enter the OTP sent\nto your phone:\n\n0. Cancel'
}

// Formats +233XXXXXXXXX → 0XXXXXXXXX for display
function formatLocal(phone: string): string {
  if (phone.startsWith('+233')) return '0' + phone.slice(4)
  if (phone.startsWith('233')) return '0' + phone.slice(3)
  return phone
}
