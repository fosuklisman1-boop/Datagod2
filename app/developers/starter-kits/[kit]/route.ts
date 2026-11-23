import { starterKitResponse } from "@/lib/api-v2/docs/starter-kits"

export const dynamic = "force-dynamic"
export const dynamicParams = true

export async function GET(_req: Request, ctx: { params: Promise<{ kit: string }> }) {
  return starterKitResponse((await ctx.params).kit)
}
