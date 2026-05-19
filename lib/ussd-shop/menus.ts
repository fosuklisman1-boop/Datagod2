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

export function networkMenu(shopName: string, networks: string[]): string {
  const lines = networks.map((n, i) => `${i + 1}. ${n}`)
  lines.push('0. Back')
  return `${shopName}\nSelect Network:\n` + lines.join('\n')
}

export function bundleMenu(shopName: string, bundles: ShopBundleOption[], page: number, total: number): string {
  const offset = page * PAGE_SIZE
  const lines = bundles.map((b, i) => `${offset + i + 1}. ${b.size} - GHS ${b.price.toFixed(2)}`)
  const hasMore = offset + bundles.length < total
  if (hasMore) lines.push(`${offset + bundles.length + 1}. More...`)
  lines.push('0. Back')
  return `${shopName}\nSelect Bundle:\n` + lines.join('\n')
}

export function recipientPrompt(): string {
  return 'Enter recipient number\n(who gets the data):\n\n0. Back'
}

export function confirmMenu(shopName: string, network: string, size: string, price: number, recipient: string, dialingPhone: string): string {
  const localDialing = formatLocal(dialingPhone)
  const localRecipient = formatLocal(recipient)
  return (
    `${shopName}\n` +
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
