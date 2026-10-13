export interface Group {
  id: string; name: string; description: string | null
  created_at: string; updated_at: string; contact_count: number
}
export interface BulkImportResult {
  inserted: number; skipped: number; pendingVerify: number
  skippedSamples: { phone: string; reason: "invalid" | "duplicate" }[]
}
export interface VerifyCounts { total: number; pending: number; verified: number; invalid: number; unverified: number; done: boolean }
export interface VerifyChunk { processed: number; verified: number; invalid: number; rateLimited: number; remaining: number }
