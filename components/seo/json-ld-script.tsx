import { headers } from "next/headers"

/**
 * Inline JSON-LD carrying the per-request CSP nonce. `<` is escaped so a
 * string value can never close the script tag (`</script>` breakout).
 */
export async function JsonLd({ data }: { data: object | object[] }) {
  const nonce = (await headers()).get("x-nonce") ?? undefined
  return (
    <script
      type="application/ld+json"
      nonce={nonce}
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data).replace(/</g, "\\u003c") }}
    />
  )
}
