import { searchIndexResponse } from "@/lib/api-v2/docs/doc-responses"

export const dynamic = "force-static"

export async function GET() {
  return searchIndexResponse()
}
