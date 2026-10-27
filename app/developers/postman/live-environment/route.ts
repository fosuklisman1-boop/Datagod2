import { buildPostmanEnvironment } from "@/lib/api-v2/docs/postman"
import { postmanDownload } from "@/lib/api-v2/docs/postman-download"

export const dynamic = "force-dynamic"

export async function GET() {
  return postmanDownload(buildPostmanEnvironment("live"), "datagod-v2-live.postman_environment.json")
}
