/**
 * The sender ID a send uses when the client doesn't pick one: the account's OLDEST active
 * own sender ID, else null (the platform default). Shared by the send route, the compose
 * preview route and the home summary so they cannot drift.
 */
export async function loadDefaultSender(
  // Minimal structural type so both the service-role client and test fakes fit.
  db: { from: (table: string) => any },
  accountId: string,
): Promise<string | null> {
  const { data } = await db
    .from("sms_sender_ids")
    .select("sender_id")
    .eq("sms_account_id", accountId)
    .eq("local_status", "active")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle()
  return (data as { sender_id?: string } | null)?.sender_id ?? null
}
