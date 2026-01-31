import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

// GET: Get packages with dealer pricing for users with 'dealer' role
export async function GET(request: NextRequest) {
    try {
        const authHeader = request.headers.get("Authorization")
        if (!authHeader?.startsWith("Bearer ")) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
        }

        const token = authHeader.slice(7)
        const { data: { user }, error: authError } = await supabase.auth.getUser(token)

        if (authError || !user) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
        }

        // Check if the user has 'dealer' role
        const { data: userData, error: userError } = await supabase
            .from("users")
            .select("role")
            .eq("id", user.id)
            .single()

        if (userError || !userData) {
            return NextResponse.json({ error: "User not found" }, { status: 404 })
        }

        if (userData.role !== "dealer" && userData.role !== "admin") {
            return NextResponse.json({ error: "Access denied. Dealer/Admin role required." }, { status: 403 })
        }

        // Fetch active packages with dealer pricing
        const { data: packages, error: pkgError } = await supabase
            .from("packages")
            .select("id, network, size, price, dealer_price, description, active")
            .eq("active", true)
            .order("network")
            .order("size")

        if (pkgError) {
            console.error("[DEALER-PACKAGES] Error fetching packages:", pkgError)
            return NextResponse.json({ error: "Failed to fetch packages" }, { status: 500 })
        }

        // Transform packages: use dealer_price as the price
        const dealerPackages = (packages || []).map((pkg: any) => ({
            id: pkg.id,
            network: pkg.network,
            size: pkg.size,
            // Use dealer_price if set, otherwise fall back to regular price
            price: pkg.dealer_price ?? pkg.price,
            original_price: pkg.price,
            dealer_price: pkg.dealer_price,
            description: pkg.description,
            active: pkg.active,
            has_dealer_discount: pkg.dealer_price !== null && pkg.dealer_price < pkg.price
        }))

        console.log(`[DEALER-PACKAGES] Returning ${dealerPackages.length} packages for dealer ${user.id}`)

        return NextResponse.json({
            success: true,
            packages: dealerPackages
        })

    } catch (error) {
        console.error("[DEALER-PACKAGES] Error:", error)
        return NextResponse.json(
            { error: "Failed to load packages" },
            { status: 500 }
        )
    }
}
