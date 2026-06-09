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
export function rcMenu(): string {
  return 'Results Checker\n1. Buy Vouchers\n2. My Vouchers\n3. Check Results\n0. Back'
}

export function rcCheckBoardMenu(): string {
  return 'Check Results Service\nSelect exam board:\n1. WAEC\n2. BECE\n3. NOVDEC\n0. Back'
}

export function rcCheckCandidateTypeMenu(): string {
  return 'Candidate Type:\n1. School\n2. Private\n0. Back'
}

export function rcCheckModeMenu(comboTotal: number, checkFee: number): string {
  return (
    `Check Results\nHow to pay?\n` +
    `1. Buy voucher+check\n   GHS ${comboTotal.toFixed(2)}\n` +
    `2. I have a voucher\n   GHS ${checkFee.toFixed(2)}\n` +
    `0. Back`
  )
}

export function rcCheckVoucherPrompt(): string {
  return 'Enter voucher PIN\nand serial number:\n(PIN/Serial)\ne.g. 1234/567890\n\n0. Back'
}

export function rcCheckIndexPrompt(): string {
  return 'Enter your index number:\n\n0. Back'
}

export function rcCheckDobPrompt(): string {
  return 'Enter date of birth:\n(DD/MM/YYYY)\ne.g. 15/06/2008\n\n0. Back'
}

export function rcCheckYearPrompt(): string {
  return 'Enter exam year:\n(e.g. 2024)\n\n0. Back'
}

export function rcCheckConfirmMenu(
  board: string,
  candidateType: 'school' | 'private',
  indexNo: string,
  dob: string,
  year: number,
  fee: number,
  balance: number,
  channel: 'ussd' | 'whatsapp' = 'ussd',
  mode: 'combo' | 'own_voucher' = 'own_voucher',
  comboTotal?: number,
  voucherPin?: string,
  voucherSerial?: string,
): string {
  const boardLine = `${board} (${candidateType === 'school' ? 'School' : 'Private'})`
  if (channel === 'whatsapp') {
    if (mode === 'combo') {
      return (
        `Check Results\n${boardLine}\nIndex: ${indexNo}\nDOB: ${dob}\nYear: ${year}\n` +
        `1 voucher+check\nTotal: GHS ${(comboTotal ?? fee).toFixed(2)}\n\n1. Pay via MoMo\n0. Cancel`
      )
    }
    return (
      `Check Results\n${boardLine}\nIndex: ${indexNo}\nDOB: ${dob}\nYear: ${year}\n` +
      `PIN: ${voucherPin ?? '—'}\nSerial: ${voucherSerial ?? '—'}\n` +
      `Fee: GHS ${fee.toFixed(2)}\n\n1. Pay via MoMo\n0. Cancel`
    )
  }
  // USSD (wallet)
  const amount = mode === 'combo' ? (comboTotal ?? fee) : fee
  const hasBalance = balance >= amount
  const payLine = hasBalance
    ? `1. Pay GHS ${amount.toFixed(2)}\n0. Cancel`
    : `Insufficient wallet.\n0. Back`
  const detail = mode === 'combo' ? `Voucher+check` : `PIN: ${voucherPin ?? '—'}`
  return `${boardLine}\n${indexNo} · ${year}\nDOB: ${dob}\n${detail}\n${payLine}`
}

export function rcMyVouchersMenu(orders: Array<{ exam_board: string; reference_code: string; created_at: string }>): string {
  if (orders.length === 0) return 'No completed vouchers\nfor this number.\n\n0. Back'
  const lines = orders.map((o, i) => {
    const date = new Date(o.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
    return `${i + 1}. ${o.exam_board} ${o.reference_code} (${date})`
  })
  lines.push('0. Back')
  return 'My Vouchers\n' + lines.join('\n')
}

export function rcVoucherDetailMenu(board: string, ref: string, qty: number, createdAt: string): string {
  const date = new Date(createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
  return `${board} ${ref}\n${qty} voucher${qty !== 1 ? 's' : ''} · ${date}\n\n1. Resend SMS\n0. Back`
}

export function rcBoardMenu(boards: string[]): string {
  const lines = boards.map((b, i) => `${i + 1}. ${b}`)
  lines.push('0. Back')
  return 'Results Checker\nSelect exam:\n' + lines.join('\n')
}

export function rcQtyPrompt(board: string, available: number, max: number, bulk?: { minQty: number; unitPrice: number } | null): string {
  const cap = Math.min(available, max)
  const hint = bulk ? `\nBuy ${bulk.minQty}+ for GHS ${bulk.unitPrice.toFixed(2)}/ea` : ''
  return `${board} Checker\nHow many vouchers?\n(1 - ${cap}):${hint}\n\n0. Back`
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

function formatBundleSize(size: string): string {
  const n = parseFloat(size)
  if (isNaN(n)) return size
  if (n < 1) return `${Math.round(n * 1000)}MB`
  return `${Number.isInteger(n) ? n : n}GB`
}

export function bundleMenu(bundles: BundleOption[], page: number, total: number): string {
  const offset = page * PAGE_SIZE
  const lines = bundles.map((b, i) => `${offset + i + 1}. ${formatBundleSize(b.size)} - GHS ${b.price.toFixed(2)}`)
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
    `${formatBundleSize(size)} ${network}\n` +
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
