import { createClient } from "@supabase/supabase-js"

// Channel-tagged shop order creation. Extracted verbatim from the
// ussd_shop_orders / airtime_orders / results_checker_orders INSERTs in
// lib/ussd-shop/handlers/{bundles,airtime,results-checker}.ts so both the
// USSD shop and the WhatsApp shop bot can create orders through the exact
// same insert shape — only the `channel` tag differs. This lets the existing
// Paystack webhook (which already fulfills these three tables by reference)
// tell a WhatsApp-bot order apart from a USSD order for later
// channel-specific logic (e.g. token deduction). Deliberately does NOT do
// pricing/verification, session writes, or payment initiation — those stay
// channel-specific and live in the callers.

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// Using `typeof supabase` (rather than `ReturnType<typeof createClient>`) keeps the
// exact instantiated generic type — createClient's default type params don't survive
// ReturnType applied to the uninstantiated generic function.
type SupabaseClientLike = typeof supabase

export type ShopOrderChannel = "ussd_shop" | "whatsapp_shop"

// ── Data bundle ────────────────────────────────────────────────────────────

export interface BundleOrderInput {
  shopCodeId: string
  shopId: string
  parentShopId: string | null
  dialingPhone: string
  recipientPhone: string
  network: string
  paystackProvider: string
  bundleId: string
  bundleSize: string
  verifiedPrice: number
  profitAmount: number
  parentProfitAmount: number
  chargeAmount: number
  shopName: string | null
  customerEmail: string | null
  shopOwnerEmail: string | null
  channel: ShopOrderChannel
}

export async function createShopBundleOrder(
  input: BundleOrderInput,
  client: SupabaseClientLike = supabase
): Promise<{ orderId: string } | { error: string }> {
  const { data, error } = await client
    .from("ussd_shop_orders")
    .insert([{
      shop_code_id: input.shopCodeId,
      shop_id: input.shopId,
      dialing_phone: input.dialingPhone,
      recipient_phone: input.recipientPhone,
      network: input.network,
      paystack_provider: input.paystackProvider,
      package_id: input.bundleId,
      package_size: input.bundleSize,
      amount: input.chargeAmount,
      shop_price: input.verifiedPrice,
      profit_amount: input.profitAmount,
      parent_shop_id: input.parentShopId,
      parent_profit_amount: input.parentProfitAmount,
      shop_name: input.shopName,
      customer_email: input.customerEmail,
      shop_owner_email: input.shopOwnerEmail,
      order_status: 'pending',
      payment_status: 'pending',
      channel: input.channel,
    }])
    .select("id")
    .single()

  if (error || !data) {
    return { error: error?.message ?? "Failed to create bundle order" }
  }
  return { orderId: data.id }
}

// ── Airtime ────────────────────────────────────────────────────────────────

export interface AirtimeOrderInput {
  referenceCode: string
  network: string
  beneficiaryPhone: string
  airtimeAmount: number  // amount actually delivered to the beneficiary (post-fee)
  feeAmount: number
  totalPaid: number      // amount charged to the payer (inclusive of fee)
  shopId: string
  merchantCommission: number
  dialingPhone: string
  channel: ShopOrderChannel
  // Optional — default to today's USSD-only literal so the existing USSD caller
  // (lib/ussd-shop/handlers/airtime.ts, not yet migrated to this function) stays
  // byte-identical. admin/airtime surfaces read customer_email || customer_name
  // as the identity fallback, so once a WhatsApp caller exists it should pass its
  // real name/email through here rather than getting the wrong literal.
  customerName?: string
  customerEmail?: string | null
}

export async function createShopAirtimeOrder(
  input: AirtimeOrderInput,
  client: SupabaseClientLike = supabase
): Promise<{ orderId: string } | { error: string }> {
  const { data, error } = await client
    .from("airtime_orders")
    .insert([{
      reference_code: input.referenceCode,
      network: input.network,
      beneficiary_phone: input.beneficiaryPhone,
      airtime_amount: input.airtimeAmount,
      fee_amount: input.feeAmount,
      total_paid: input.totalPaid,
      pay_separately: false,
      status: "pending_payment",
      payment_status: "pending_payment",
      user_id: null,
      shop_id: input.shopId,
      merchant_commission: input.merchantCommission,
      customer_name: input.customerName ?? "USSD Customer",
      customer_email: input.customerEmail ?? null,
      dialing_phone: input.dialingPhone,
      channel: input.channel,
    }])
    .select("id")
    .single()

  if (error || !data) {
    return { error: error?.message ?? "Failed to create airtime order" }
  }
  return { orderId: data.id }
}

// ── Results Checker ───────────────────────────────────────────────────────

export interface RcOrderInput {
  referenceCode: string
  examBoard: string
  quantity: number
  customerPhone: string  // local-format number the voucher is associated with (e.g. localDialing)
  unitPrice: number
  totalPaid: number
  shopId: string
  merchantCommission: number
  dialingPhone: string
  channel: ShopOrderChannel
  // Optional — see the same fields on AirtimeOrderInput above for rationale.
  customerName?: string
  customerEmail?: string | null
}

export async function createShopRcOrder(
  input: RcOrderInput,
  client: SupabaseClientLike = supabase
): Promise<{ orderId: string } | { error: string }> {
  const { data, error } = await client
    .from("results_checker_orders")
    .insert([{
      reference_code: input.referenceCode,
      exam_board: input.examBoard,
      quantity: input.quantity,
      customer_name: input.customerName ?? "USSD Customer",
      customer_email: input.customerEmail ?? null,
      customer_phone: input.customerPhone,
      unit_price: input.unitPrice,
      fee_amount: 0,
      total_paid: input.totalPaid,
      shop_id: input.shopId,
      merchant_commission: input.merchantCommission,
      status: "pending_payment",
      payment_status: "pending_payment",
      dialing_phone: input.dialingPhone,
      channel: input.channel,
    }])
    .select("id")
    .single()

  if (error || !data) {
    return { error: error?.message ?? "Failed to create results checker order" }
  }
  return { orderId: data.id }
}

// ── Check My Results (Datagod checks the customer's result, distinct from
// the voucher-purchase RcOrderInput above) ──────────────────────────────────

export interface CheckResultsRequestInput {
  examBoard: string
  candidateType: 'school' | 'private'
  indexNumber: string
  examYear: number
  dob: string
  mode: 'combo' | 'own_voucher'
  voucherPin?: string | null
  voucherSerial?: string | null
  phoneNumber: string       // customer's own number, local format — this table's identity column
  whatsappNumber: string    // same number; the shop bot always knows it, no separate ask
  fee: number
  paymentReference: string
  shopId: string
  merchantCommission: number
  channel: ShopOrderChannel
}

export async function createShopCheckResultsRequest(
  input: CheckResultsRequestInput,
  client: SupabaseClientLike = supabase
): Promise<{ orderId: string } | { error: string }> {
  const { data, error } = await client
    .from("results_check_requests")
    .insert([{
      exam_board: input.examBoard,
      candidate_type: input.candidateType,
      index_number: input.indexNumber,
      exam_year: input.examYear,
      dob: input.dob,
      mode: input.mode,
      voucher_pin: input.mode === 'own_voucher' ? (input.voucherPin ?? null) : null,
      voucher_serial: input.mode === 'own_voucher' ? (input.voucherSerial ?? null) : null,
      phone_number: input.phoneNumber,
      whatsapp_number: input.whatsappNumber,
      fee: input.fee,
      payment_reference: input.paymentReference,
      shop_id: input.shopId,
      merchant_commission: input.merchantCommission,
      user_id: null,
      payment_status: "pending_payment",
      status: "pending",
      channel: input.channel,
    }])
    .select("id")
    .single()

  if (error || !data) {
    return { error: error?.message ?? "Failed to create results check request" }
  }
  return { orderId: data.id }
}
