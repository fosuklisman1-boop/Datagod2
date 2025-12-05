import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

export async function POST(request: NextRequest) {
  try {
    const { balanceImagePath, momoReceiptPath } = await request.json()

    if (!balanceImagePath && !momoReceiptPath) {
      return NextResponse.json(
        { message: "No image paths provided" },
        { status: 400 }
      )
    }

    const urls: any = {}

    // Generate signed URL for balance image
    if (balanceImagePath) {
      const { data: balanceSignedUrlData, error: balanceError } = await supabase.storage
        .from("complaint-evidence")
        .createSignedUrl(balanceImagePath, 24 * 60 * 60) // 24 hours

      if (balanceError) {
        console.error("Error generating balance image signed URL:", balanceError)
        urls.balance_image_url = null
      } else {
        urls.balance_image_url = balanceSignedUrlData?.signedUrl || null
      }
    }

    // Generate signed URL for MoMo receipt
    if (momoReceiptPath) {
      const { data: momoSignedUrlData, error: momoError } = await supabase.storage
        .from("complaint-evidence")
        .createSignedUrl(momoReceiptPath, 24 * 60 * 60) // 24 hours

      if (momoError) {
        console.error("Error generating MoMo receipt signed URL:", momoError)
        urls.momo_receipt_url = null
      } else {
        urls.momo_receipt_url = momoSignedUrlData?.signedUrl || null
      }
    }

    return NextResponse.json(urls)
  } catch (error) {
    console.error("Error in evidence URLs generation:", error)
    return NextResponse.json(
      { message: "Internal server error" },
      { status: 500 }
    )
  }
}
