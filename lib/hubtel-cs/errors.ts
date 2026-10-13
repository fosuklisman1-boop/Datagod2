export class HubtelDisabledError extends Error {
  constructor() { super("Hubtel Commission Services is disabled"); this.name = "HubtelDisabledError" }
}
export class HubtelServiceDisabledError extends Error {
  constructor(public serviceKey: string) { super(`Hubtel service ${serviceKey} is disabled`); this.name = "HubtelServiceDisabledError" }
}
export class HubtelPausedError extends Error {
  constructor(public reason: string | null) { super(`Hubtel Commission Services is paused${reason ? `: ${reason}` : ""}`); this.name = "HubtelPausedError" }
}
export class HubtelNotConfiguredError extends Error {
  constructor(public missing: string[]) { super(`Hubtel Commission Services not configured: missing ${missing.join(", ")}`); this.name = "HubtelNotConfiguredError" }
}
export class HubtelValidationError extends Error {
  constructor(message: string) { super(message); this.name = "HubtelValidationError" }
}
export class HubtelOutcomeUnknownError extends Error {
  constructor(public clientReference: string, public cause: unknown) {
    super(`Hubtel POST was sent for ${clientReference} but the outcome could not be recorded; do NOT retry`)
    this.name = "HubtelOutcomeUnknownError"
  }
}
export class HubtelDuplicateOrderError extends Error {
  constructor(public orderTable: string | null, public orderId: string | null) {
    super(`A live Hubtel transaction already exists for order ${orderTable ?? "?"}/${orderId ?? "?"}`)
    this.name = "HubtelDuplicateOrderError"
  }
}
