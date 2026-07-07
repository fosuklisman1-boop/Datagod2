// Public, cacheable prefix map for client-side hints. The mapping is public
// knowledge (which prefix belongs to which Ghana carrier) — no auth needed.
import { NextResponse } from "next/server"
import { getPrefixValidationConfig } from "@/lib/network-prefix-config"

export const dynamic = "force-dynamic"

export async function GET() {
  const { map } = await getPrefixValidationConfig()
  return NextResponse.json({ map }, {
    headers: { "Cache-Control": "public, max-age=300, s-maxage=300" },
  })
}
