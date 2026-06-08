import { UzoResponse, ShopBundleOption } from "./types"

const PAGE_SIZE = 5
const SCREEN_LIMIT = 160

export function cont(message: string): UzoResponse {
  return { message: truncate(message), ussdServiceOp: 2 }
}

export function end(message: string): UzoResponse {
  return { message: truncate(message), ussdServiceOp: 17 }
}

function truncate(msg: string): string {
  return msg.length > SCREEN_LIMIT ? msg.slice(0, SCREEN_LIMIT - 3) + '...' : msg
}

export function enterShopCodeMenu(): string {
  return 'Welcome to DataGod\nEnter shop code:\n\n0. Exit'
}

export function invalidCodeMenu(reason: string): string {
  return `${reason}\n\nEnter shop code:\n\n0. Exit`
}

export function productMenu(shopName: string): string {
  return `${gsm7(shopName)}\nWhat to buy?\n1. Data Bundle\n2. Airtime\n3. Results Checker\n0. Exit`
}

// ── Shop Airtime ──────────────────────────────────────────────────────────────
export function shopAirtimeRecipientPrompt(shopName: string): string {
  return `${gsm7(shopName)}\nBuy Airtime\nEnter recipient number:\n\n0. Back`
}

export function shopAirtimeNetworkMenu(): string {
  return 'Select Network:\n1. MTN\n2. Telecel\n3. AirtelTigo\n\n0. Back'
}

export function shopAirtimeAmountPrompt(network: string, min: number, max: number): string {
  return `${network} Airtime\nEnter amount to pay\n(GHS ${min} - ${max}):\n\n0. Back`
}

export function shopAirtimeConfirmMenu(shopName: string, network: string, recipient: string, pay: number, get: number, dialingPhone: string): string {
  return (
    `${gsm7(shopName)}\n` +
    `${network} to ${formatLocal(recipient)}\n` +
    `Pay GHS ${pay.toFixed(2)}\n` +
    `Get GHS ${get.toFixed(2)}\n` +
    `from ${formatLocal(dialingPhone)}\n\n` +
    `1. Pay now\n2. Cancel`
  )
}

// ── Shop Results Checker ──────────────────────────────────────────────────────
export function shopRcBoardMenu(shopName: string, boards: string[]): string {
  const lines = boards.map((b, i) => `${i + 1}. ${b}`)
  lines.push('0. Back')
  return `${gsm7(shopName)}\nSelect exam:\n` + lines.join('\n')
}

export function shopRcQtyPrompt(board: string, available: number, max: number): string {
  const cap = Math.min(available, max)
  return `${board} Checker\nHow many vouchers?\n(1 - ${cap}):\n\n0. Back`
}

export function shopRcConfirmMenu(shopName: string, board: string, qty: number, total: number, dialingPhone: string): string {
  return (
    `${gsm7(shopName)}\n` +
    `${board} x ${qty}\n` +
    `GHS ${total.toFixed(2)} from\n${formatLocal(dialingPhone)}\n` +
    `PIN(s) sent by SMS\n\n` +
    `1. Pay now\n2. Cancel`
  )
}

const NETWORK_PRIORITY: Record<string, number> = { mtn: 1, telecel: 2, airteltigo: 3, 'at-ishare': 4 }

export function sortNetworks(nets: string[]): string[] {
  return [...nets].sort((a, b) => {
    const pa = NETWORK_PRIORITY[a.toLowerCase()] ?? 99
    const pb = NETWORK_PRIORITY[b.toLowerCase()] ?? 99
    return pa !== pb ? pa - pb : a.localeCompare(b)
  })
}

export function networkMenu(shopName: string, networks: string[]): string {
  const sorted = sortNetworks(networks)
  const lines = sorted.map((n, i) => `${i + 1}. ${n}`)
  lines.push('0. Back')
  return `${gsm7(shopName)}\nSelect Network:\n` + lines.join('\n')
}

// Strip characters outside printable ASCII — prevents emoji/Unicode from
// triggering UCS-2 encoding on the carrier and halving the screen limit.
function gsm7(s: string): string {
  return s.replace(/[^\x20-\x7E]/g, '').trim()
}

export function bundleMenu(
  shopName: string,
  bundles: ShopBundleOption[],
  page: number,
  total: number
): { text: string; shown: number } {
  const offset = page * PAGE_SIZE
  const limit = 160
  const header = `${gsm7(shopName)}\nSelect Bundle:\n`
  const back = '0. Back'

  let body = ''
  let shown = 0

  for (let i = 0; i < bundles.length; i++) {
    const line = `${offset + i + 1}. ${bundles[i].size} - GHS ${bundles[i].price.toFixed(2)}\n`
    const afterThis = i + 1
    const hasMoreAfterThis = afterThis < bundles.length || (offset + afterThis) < total
    const moreLine = hasMoreAfterThis ? `${offset + afterThis + 1}. More...\n` : ''

    const fits = header.length + body.length + line.length + moreLine.length + back.length <= limit
    if (!fits && i > 0) break

    body += line
    shown++
  }

  const hasMore = shown < bundles.length || (offset + shown) < total
  if (hasMore) body += `${offset + shown + 1}. More...\n`

  return { text: header + body + back, shown }
}

export function recipientPrompt(): string {
  return 'Enter recipient number\n(who gets the data):\n\n0. Back'
}

export function confirmMenu(shopName: string, network: string, size: string, price: number, recipient: string, dialingPhone: string): string {
  const localDialing = formatLocal(dialingPhone)
  const localRecipient = formatLocal(recipient)
  return (
    `${gsm7(shopName)}\n` +
    `${size} ${network}\n` +
    `To: ${localRecipient}\n` +
    `GHS ${price.toFixed(2)} from\n${localDialing}\n\n` +
    `1. Pay now\n2. Cancel`
  )
}

export function paymentSentMenu(localPhone: string): string {
  return `MoMo prompt sent to ${localPhone}. Approve to complete.\n\nReceived an OTP instead? Redial and enter the code.`
}

export function otpMenu(): string {
  return `Pending payment.\nEnter the OTP sent\nto your number to\ncomplete payment:\n\n0. Cancel`
}

function formatLocal(phone: string): string {
  if (phone.startsWith('+233')) return '0' + phone.slice(4)
  if (phone.startsWith('233')) return '0' + phone.slice(3)
  return phone
}
