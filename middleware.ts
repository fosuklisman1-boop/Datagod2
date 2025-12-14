import { type NextRequest, NextResponse } from "next/server"

export function middleware(request: NextRequest) {
  // For now, allow all requests through
  // The client-side will handle redirects based on auth state
  return NextResponse.next()
}

export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - api (API routes)
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon-v2.jpeg (favicon file)
     * - public (public files)
     */
    "/((?!api|_next/static|_next/image|favicon-v2.jpeg|public).*)",
  ],
}
