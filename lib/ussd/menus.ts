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
  return 'Welcome to Datagod\n1. Buy Data Bundle\n2. Check Order Status\n0. Exit'
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
