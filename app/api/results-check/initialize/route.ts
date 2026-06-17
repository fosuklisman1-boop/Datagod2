import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import {
  EXAM_BOARDS,
  isValidIndexNumber,
  isValidVoucherPin,
  isValidVoucherSerial,
  isValidDob,
  isValidExamYear,
  isValidGhanaPhone,
  type ExamBoard,
} from "@/lib/results-check-validation"
import {
  isExamBoardEnabled,
  getAvailableCount,
  calculateResultsCheckPrice,
} from "@/lib/results-checker-service"
import { secureReference } from "@/lib/secure-random"
import { applyRateLimit } from "@/lib/rate-limiter"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const VALID_CANDIDATE_TYPES = new Set(["school", "private"])
const VALID_MODES = new Set(["combo", "own_voucher"])

// Dashboard (authenticated dealer) version of the Results Check Service initialize.
// Unlike the public storefront route there's no Turnstile/honeypot/OTP (the caller
// is an authenticated dealer), NO shop markup (dealer pays Datagod's BASE fee and
// marks up their walk-in customer offline), and channel='web'. Payment is then run
// through the shared /api/payments/initialize (orderType:"results_check_service"),
// which deducts the dealer's wallet / prompts MoMo and fulfils via the webhook.
export async function POST(request: NextRequest) {
  try {
    const authHeader = request.headers.get("authorization")
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
    const { data: { user }, error: authError } = await supabase.auth.getUser(authHeader.slice(7))
    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const body = await request.json()
    const {
      examBoard, candidateType, mode, indexNumber, examYear: rawExamYear, dob,
      voucherPin, voucherSerial, whatsappNumber,
    } = body

    if (!examBoard || !candidateType || !mode || !indexNumber || !rawExamYear || !dob || !whatsappNumber) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 })
    }

    // ── Validation (board-aware) ──
    if (!EXAM_BOARDS.includes(examBoard)) {
      return NextResponse.json({ error: "Invalid examBoard. Must be WASSCE, BECE, or NOVDEC" }, { status: 400 })
    }
    const board = examBoard as ExamBoard

    if (!VALID_CANDIDATE_TYPES.has(candidateType)) {
      return NextResponse.json({ error: "Invalid candidateType. Must be school or private" }, { status: 400 })
    }
    if (!VALID_MODES.has(mode)) {
      return NextResponse.json({ error: "Invalid mode. Must be combo or own_voucher" }, { status: 400 })
    }
    if (!isValidIndexNumber(board, String(indexNumber).trim())) {
      return NextResponse.json({ error: "Invalid index number format" }, { status: 400 })
    }
    const examYear = parseInt(rawExamYear)
    if (!isValidExamYear(examYear)) {
      return NextResponse.json({ error: "Invalid exam year" }, { status: 400 })
    }
    if (!isValidDob(String(dob))) {
      return NextResponse.json({ error: "Invalid date of birth. Use DD/MM/YYYY" }, { status: 400 })
    }
    if (!isValidGhanaPhone(String(whatsappNumber))) {
      return NextResponse.json({ error: "Invalid WhatsApp number" }, { status: 400 })
    }

    let normalizedVoucherPin: string | null = null
    let normalizedVoucherSerial: string | null = null
    if (mode === "own_voucher") {
      if (!voucherPin || !isValidVoucherPin(board, String(voucherPin))) {
        return NextResponse.json({ error: board === "BECE" ? "Invalid voucher PIN (BECE PINs are 10–12 letters/digits)" : "Invalid voucher PIN. Must be 12 digits" }, { status: 400 })
      }
      if (!voucherSerial || !isValidVoucherSerial(board, String(voucherSerial))) {
        return NextResponse.json({ error: "Invalid voucher serial number" }, { status: 400 })
      }
      normalizedVoucherPin = String(voucherPin).trim()
      normalizedVoucherSerial = String(voucherSerial).trim().toUpperCase()
    }

    // ── Service availability ──
    const settings = await supabase
      .from("admin_settings").select("value").eq("key", "results_check_settings").single()
    if (settings.data?.value?.enabled === false) {
      return NextResponse.json({ error: "Results Check Service is currently unavailable" }, { status: 503 })
    }
    if (!(await isExamBoardEnabled(board))) {
      return NextResponse.json({ error: `${board} results checking is currently unavailable` }, { status: 503 })
    }
    if (mode === "combo" && (await getAvailableCount(board)) < 1) {
      return NextResponse.json(
        { error: `${board} vouchers are out of stock. Choose "I have my own voucher" instead.` },
        { status: 409 }
      )
    }

    // Idempotency: block a duplicate pending request from the same dealer for the
    // same candidate within 30s (double-submit / retry).
    const thirtySecondsAgo = new Date(Date.now() - 30_000).toISOString()
    const { data: recent } = await supabase
      .from("results_check_requests")
      .select("id, payment_reference")
      .eq("user_id", user.id)
      .eq("index_number", String(indexNumber).trim())
      .eq("exam_board", board)
      // Catch BOTH a still-pending and a JUST-PAID duplicate: the wallet path flips
      // the request to 'paid' within milliseconds, so checking only 'pending_payment'
      // would let a rapid double-submit charge the wallet twice.
      .in("payment_status", ["pending_payment", "paid"])
      .gte("created_at", thirtySecondsAgo)
      .maybeSingle()
    if (recent) {
      return NextResponse.json({ error: "Duplicate request — please wait a moment.", reference: recent.payment_reference }, { status: 409 })
    }

    // Atomic backstop for the DB guard above (which is a non-transactional
    // SELECT-then-deduct): 1 submit per 30s per (dealer, board, index) closes the
    // concurrent/retry double-charge window on the wallet path. Time-bounded so a
    // legitimate later re-check of the same candidate is still allowed.
    const dupCap = await applyRateLimit(
      request, "rc_dash_check_dup", 1, 30_000,
      `u:${user.id}:${board}:${String(indexNumber).trim()}`
    )
    if (!dupCap.allowed) {
      return NextResponse.json({ error: "Duplicate request — please wait a moment." }, { status: 409 })
    }

    // Base fee — NO shopId, so no markup (dealer pays Datagod's price).
    const pricing = await calculateResultsCheckPrice({ examBoard: board, mode })
    const reference = secureReference("RCK", 2, 3)

    // Dealer's own contact for the receipt; results are delivered to whatsappNumber.
    const { data: profile } = await supabase
      .from("users").select("email, first_name, phone_number").eq("id", user.id).maybeSingle()

    const payFrom = body.payFrom === "momo" ? "momo" : "wallet" // dashboard defaults to wallet
    const baseRow = {
      phone_number: String(whatsappNumber).trim(),
      exam_board: board,
      candidate_type: candidateType,
      index_number: String(indexNumber).trim(),
      dob: String(dob).trim(),
      exam_year: examYear,
      fee: pricing.totalPaid,
      mode,
      voucher_pin: normalizedVoucherPin,
      voucher_serial: normalizedVoucherSerial,
      whatsapp_number: String(whatsappNumber).trim(),
      status: "pending",
      channel: "web",
      payment_reference: reference,
      customer_name: profile?.first_name ?? "Dealer",
      customer_email: profile?.email ?? user.email ?? null,
      user_id: user.id,
      shop_id: null,
      merchant_commission: 0,
    }

    if (payFrom === "wallet") {
      // Deduct FIRST (atomic) so an insufficient balance creates nothing.
      const { data: deduct, error: deductErr } = await supabase.rpc("deduct_wallet", {
        p_user_id: user.id,
        p_amount: pricing.totalPaid,
      })
      if (deductErr) {
        console.error("[RC-DASH-INIT] Wallet deduct error:", deductErr)
        return NextResponse.json({ error: "Failed to process payment" }, { status: 500 })
      }
      if (!deduct || deduct.length === 0) {
        return NextResponse.json({ error: "Insufficient wallet balance", required: pricing.totalPaid }, { status: 402 })
      }
      const { new_balance: newBalance, old_balance: balanceBefore } = deduct[0] as { new_balance: number; old_balance: number }

      const { data: requestRow, error: insErr } = await supabase
        .from("results_check_requests")
        .insert([{ ...baseRow, payment_status: "pending_payment" }])
        .select()
        .single()
      if (insErr || !requestRow) {
        // Refund the deducted amount — nothing was created.
        await supabase.rpc("credit_wallet_safely", {
          p_user_id: user.id,
          p_amount: pricing.totalPaid,
          p_reference_id: `refund-${reference}`,
          p_description: "Results check request creation failed — refund",
          p_source: "results_check_refund",
        })
        console.error("[RC-DASH-INIT] Request creation error (refunded):", insErr)
        return NextResponse.json({ error: "Failed to initialize request. Wallet refunded." }, { status: 500 })
      }

      // Money-trail: record the wallet debit (mirrors purchaseResultsCheckerVouchers).
      await supabase.from("transactions").insert([{
        user_id: user.id,
        type: "debit",
        source: "results_check_service",
        amount: pricing.totalPaid,
        balance_before: balanceBefore,
        balance_after: newBalance,
        description: `${board} Results Check (${mode}) — Ref: ${reference}`,
        reference_id: requestRow.id,
        status: "completed",
        created_at: new Date().toISOString(),
      }]).then(({ error }) => {
        if (error) console.warn("[RC-DASH-INIT] ledger insert failed:", error.message)
      })

      // Mark paid + assign combo voucher + notify admin (admin delivers the results).
      const { fulfillPaidResultsCheckRequest } = await import("@/lib/results-checker-service")
      await fulfillPaidResultsCheckRequest(requestRow.id).catch(e =>
        console.warn("[RC-DASH-INIT] fulfillment error (paid; admin will handle):", e)
      )

      return NextResponse.json({
        success: true,
        paid: "wallet",
        orderId: requestRow.id,
        totalPrice: pricing.totalPaid,
        reference,
        mode,
        newBalance,
      })
    }

    // MoMo: create pending; the client then calls /api/payments/initialize
    // (orderType "results_check_service") which charges + fulfils on success.
    const { data: requestRow, error: insertError } = await supabase
      .from("results_check_requests")
      .insert([{ ...baseRow, payment_status: "pending_payment" }])
      .select()
      .single()
    if (insertError || !requestRow) {
      console.error("[RC-DASH-INIT] Request creation error:", insertError)
      return NextResponse.json({ error: "Failed to initialize request" }, { status: 500 })
    }

    return NextResponse.json({
      success: true,
      orderId: requestRow.id,
      totalPrice: pricing.totalPaid,
      reference,
      mode,
    })
  } catch (error) {
    console.error("[RC-DASH-INIT] Unexpected error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
