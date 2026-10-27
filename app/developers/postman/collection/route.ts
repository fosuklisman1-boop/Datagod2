import { buildPostmanCollection } from "@/lib/api-v2/docs/postman"
import { postmanDownload } from "@/lib/api-v2/docs/postman-download"
import { V2_BASE_URL, v2DocsRegistry } from "@/lib/api-v2/docs/registry"

export const dynamic = "force-dynamic"

export async function GET() {
  return postmanDownload(buildPostmanCollection(v2DocsRegistry, V2_BASE_URL), "datagod-v2.postman_collection.json")
}
