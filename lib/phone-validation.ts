/**
 * Phone number validation utility
 * Shared validation logic for all ordering pages (bulk, data packages, storefront)
 */
import { validateNetworkPrefix, type NetworkPrefixMap } from "./phone-format"

export interface PhoneValidationResult {
  isValid: boolean
  normalized: string
  error?: string
}

export function normalizeGhanaPhoneNumber(phone: string): string {
  const cleaned = String(phone ?? "").replace(/\D/g, "")

  if (cleaned.startsWith("233") && cleaned.length === 12) {
    return `0${cleaned.slice(3)}`
  }

  if (cleaned.length === 9) {
    return `0${cleaned}`
  }

  return cleaned
}

export function normalizePhoneToE164(phone: string): string {
  const local = normalizeGhanaPhoneNumber(phone)
  if (!local) return ""
  if (local.startsWith("0") && local.length === 10) {
    return `+233${local.slice(1)}`
  }

  const cleaned = String(phone ?? "").replace(/\D/g, "")
  if (cleaned.startsWith("233")) return `+${cleaned}`
  return local.startsWith("+") ? local : `+${local}`
}

export function getGhanaPhoneLookupVariants(phone: string): string[] {
  const local = normalizeGhanaPhoneNumber(phone)
  const e164 = normalizePhoneToE164(local)
  const intl = e164.replace("+", "")

  return Array.from(new Set([
    phone,
    local,
    e164,
    intl,
  ].filter(Boolean)))
}

/**
 * Validate and normalize a phone number
 * Accepts 9 or 10 digits, automatically pads 9-digit numbers with leading 0
 * Validates network-specific prefixes
 * 
 * @param phone - Raw phone number input (can include non-digit characters)
 * @param network - Optional network name for network-specific validation
 * @returns Validation result with normalized phone number or error message
 */
export function validatePhoneNumber(
  phone: string,
  network?: string,
  map?: NetworkPrefixMap
): PhoneValidationResult {
  if (!phone?.trim()) {
    return {
      isValid: false,
      normalized: "",
      error: "Phone number is required",
    }
  }

  // Remove all non-digit characters
  const cleaned = phone.replace(/\D/g, "")

  // Accept 9 or 10 digits
  let normalized = cleaned
  if (cleaned.length === 9) {
    normalized = "0" + cleaned
  } else if (cleaned.length !== 10) {
    return {
      isValid: false,
      normalized: "",
      error: "Phone number must be 9 or 10 digits",
    }
  }

  // Must start with 0
  if (!normalized.startsWith("0")) {
    return {
      isValid: false,
      normalized: "",
      error: "Phone number must start with 0",
    }
  }

  // Network-specific validation — strict prefix↔network match via the shared
  // map-driven validator (see lib/phone-format.ts). Previously only Telecel
  // was strict; MTN/AT accepted any 02x/05x number, which let mistaken-network
  // orders through (411 found in prod, 2026-07-07).
  if (network) {
    const check = validateNetworkPrefix(network, normalized, map)
    if (!check.ok) {
      return { isValid: false, normalized: "", error: check.message }
    }
  } else {
    // Generic validation: second digit must be 2 or 5
    const secondDigit = normalized.charAt(1)
    if (secondDigit !== "2" && secondDigit !== "5") {
      return {
        isValid: false,
        normalized: "",
        error: "Phone number must start with 02 or 05",
      }
    }
  }

  return {
    isValid: true,
    normalized,
  }
}
