// Real dependencies for the developer webhook routes: system DNS + pinned HTTPS transport, and a fresh secret generator.
import { newSecret } from "./sign"
import { realCycleDeps } from "./real-deps"
import type { DevDeps } from "./dev"

export const realDevDeps: DevDeps = { ...realCycleDeps, newSecret }
