/**
 * Host routing for the Developer API v2: https://api.<root>/v2/* is served by the
 * existing /api/v2/* route handlers. Pure so the middleware stays a short call.
 * Returns the internal pathname to rewrite to, or null when the request is not a
 * v2 request on the api host (every other host and path is left untouched).
 */
export function apiHostRewrite(host: string | null | undefined, path: string, rootDomain: string): string | null {
  const hostname = (host ?? "").split(":")[0].toLowerCase()
  if (hostname !== `api.${rootDomain.toLowerCase()}`) return null
  if (path === "/v2" || path.startsWith("/v2/")) return `/api${path}`
  return null
}
