import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { AgentPortalGHProvider } from "@/lib/mtn-providers/agentportalgh-provider"

function provider() { return new AgentPortalGHProvider() }

export async function GET(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse

  const { searchParams } = new URL(request.url)
  const action = searchParams.get("action")
  const p = provider()

  switch (action) {
    case "identity":
      return NextResponse.json(await p.getIdentity())

    case "balance":
      return NextResponse.json({ balance: await p.checkBalance() })

    case "summary": {
      const from = searchParams.get("from") ?? undefined
      const to = searchParams.get("to") ?? undefined
      return NextResponse.json(await p.getWalletSummary(from, to))
    }

    case "transactions": {
      const page = parseInt(searchParams.get("page") ?? "1")
      const pageSize = parseInt(searchParams.get("page_size") ?? "25")
      return NextResponse.json(await p.getTransactions(page, pageSize))
    }

    case "topups": {
      const page = parseInt(searchParams.get("page") ?? "1")
      const pageSize = parseInt(searchParams.get("page_size") ?? "25")
      return NextResponse.json(await p.getTopups(page, pageSize))
    }

    case "services":
      return NextResponse.json(await p.getServices())

    case "webhook-config":
      return NextResponse.json(await p.getWebhookConfig())

    case "webhook-deliveries": {
      const page = parseInt(searchParams.get("page") ?? "1")
      const pageSize = parseInt(searchParams.get("page_size") ?? "50")
      return NextResponse.json(await p.getWebhookDeliveries(page, pageSize))
    }

    case "orders": {
      const filter = searchParams.get("filter") ?? undefined
      const search = searchParams.get("search") ?? undefined
      const date = searchParams.get("date") ?? undefined
      return NextResponse.json(await p.getOrders(filter, search, date))
    }

    case "order-items": {
      const orderId = searchParams.get("order_id")
      const status = searchParams.get("status") ?? undefined
      if (!orderId) return NextResponse.json({ error: "order_id is required" }, { status: 400 })
      return NextResponse.json(await p.getOrderItems(orderId, status))
    }

    default:
      return NextResponse.json({ error: "Unknown action" }, { status: 400 })
  }
}

export async function POST(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse

  const { searchParams } = new URL(request.url)
  const action = searchParams.get("action")
  const body = await request.json()
  const p = provider()

  switch (action) {
    case "topup": {
      const { amount, phone, network } = body
      if (!amount || !phone || !network) {
        return NextResponse.json({ error: "amount, phone, and network are required" }, { status: 400 })
      }
      return NextResponse.json(await p.topUp(amount, phone, network))
    }

    case "preview": {
      const { service, items } = body
      if (!service || !items) {
        return NextResponse.json({ error: "service and items are required" }, { status: 400 })
      }
      return NextResponse.json(await p.previewOrder(service, items))
    }

    case "whitelist": {
      const { msisdns } = body
      if (!Array.isArray(msisdns)) {
        return NextResponse.json({ error: "msisdns must be an array" }, { status: 400 })
      }
      return NextResponse.json(await p.verifyWhitelist(msisdns))
    }

    case "webhook-resend": {
      const { id } = body
      if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 })
      return NextResponse.json(await p.resendWebhookDelivery(id))
    }

    default:
      return NextResponse.json({ error: "Unknown action" }, { status: 400 })
  }
}

export async function PUT(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse

  const { searchParams } = new URL(request.url)
  const action = searchParams.get("action")
  const body = await request.json()

  if (action === "webhook-config") {
    const { url, enabled, regenerate_secret } = body
    if (!url || typeof enabled !== "boolean") {
      return NextResponse.json({ error: "url and enabled are required" }, { status: 400 })
    }
    return NextResponse.json(await provider().setWebhookConfig(url, enabled, regenerate_secret === true))
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 })
}
