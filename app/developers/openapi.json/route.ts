import { openApiResponse } from "@/lib/api-v2/docs/doc-responses"

export const dynamic = "force-dynamic"

export async function GET() {
  return openApiResponse()
}
