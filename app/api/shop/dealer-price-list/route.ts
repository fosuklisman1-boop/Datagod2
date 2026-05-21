import { NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// Public endpoint — returns dealer prices to support the upgrade marketing page
export async function GET() {
  try {
    const { data: packages, error } = await supabase
      .from("packages")
      .select("id, network, size, price, dealer_price, description")
      .eq("active", true)
      .order("network")
      .order("size")

    if (error) {
      console.error("[DEALER-PRICE-LIST] Error fetching packages:", error)
      return NextResponse.json({ error: "Failed to fetch packages" }, { status: 500 })
    }

    const list = (packages || []).map((pkg: any) => ({
      id: pkg.id,
      network: pkg.network,
      size: pkg.size,
      regular_price: pkg.price,
      dealer_price: pkg.dealer_price ?? pkg.price,
      description: pkg.description,
      has_discount: pkg.dealer_price !== null && pkg.dealer_price < pkg.price,
    }))

    return NextResponse.json({ packages: list })
  } catch (error) {
    console.error("[DEALER-PRICE-LIST] Error:", error)
    return NextResponse.json({ error: "Failed to load price list" }, { status: 500 })
  }
}
