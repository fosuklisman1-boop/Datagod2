// lib/roles/require-capability.ts
// Server gate: null = allowed. Anything uncertain (read error) is a 503, never an allow.
import { NextResponse } from "next/server"
import { canWith, type Capability } from "./capabilities"
import { rightsForUser } from "./permissions-repo"

export async function requireCapability(
  client: { from(table: string): any },
  userId: string,
  cap: Capability
): Promise<NextResponse | null> {
  try {
    const { rights } = await rightsForUser(client, userId)
    if (canWith(rights, cap)) return null
    return NextResponse.json({ error: "This feature isn't available for your account." }, { status: 403 })
  } catch {
    return NextResponse.json({ error: "Couldn't check your access. Please try again." }, { status: 503 })
  }
}
