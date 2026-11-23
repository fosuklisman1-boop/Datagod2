/** Admin-facing text for a failed save of the strict verification switch (client-safe, no imports). */
export function strictSaveErrorMessage(status: number, error: unknown): string {
  if (status === 409 && error === "strict_tables_missing") {
    return "Apply the strict-verification database update before turning this on"
  }
  return typeof error === "string" && error ? error : "Failed to update"
}
