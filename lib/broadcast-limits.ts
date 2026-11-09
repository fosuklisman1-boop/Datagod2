// Limits of the Broadcast page (POST /api/admin/broadcast), applied to every broadcast, including the bulk
// notifications sent from the admin users page. Pure, so pages can import it.
export const BROADCAST_LIMITS = {
  subjectMax: 200,
  messageMax: 5000,
  /**
   * Recipients per broadcast. Sending is queued (broadcast_recipients) and drained in batches, so this only bounds
   * the enqueue work done in the request. Was 5,000, which blocked real audiences larger than that.
   */
  recipientsMax: 100_000,
  /** Recipients sent synchronously when the broadcast starts; the drain-broadcasts cron sends the rest. */
  firstBatch: 30,
} as const
