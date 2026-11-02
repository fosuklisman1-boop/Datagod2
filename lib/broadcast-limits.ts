// Limits of the Broadcast page (POST /api/admin/broadcast), applied to every broadcast, including the bulk
// notifications sent from the admin users page. Pure, so pages can import it.
export const BROADCAST_LIMITS = {
  subjectMax: 200,
  messageMax: 5000,
  /** Recipients per broadcast. */
  recipientsMax: 5000,
  /** Recipients sent synchronously when the broadcast starts; the drain-broadcasts cron sends the rest. */
  firstBatch: 30,
} as const
