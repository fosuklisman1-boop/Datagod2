/**
 * Phone number validation utility
 * Shared validation logic for all ordering pages (bulk, data packages, storefront)
 */

export interface PhoneValidationResult {
  isValid: boolean
  normalized: string
  error?: string
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
  network?: string
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

  // Network-specific validation
  if (network) {
    const normalizedNetwork = network.toLowerCase()

    if (normalizedNetwork === "telecel") {
      // Telecel: must start with 020 or 050
      if (!normalized.startsWith("020") && !normalized.startsWith("050")) {
        return {
          isValid: false,
          normalized: "",
          error: "Telecel requires phone numbers starting with 020 or 050",
        }
      }
    } else {
      // Other networks (MTN, AT, etc.): second digit must be 2 or 5
      const secondDigit = normalized.charAt(1)
      if (secondDigit !== "2" && secondDigit !== "5") {
        return {
          isValid: false,
          normalized: "",
          error: "Invalid phone format. After 0, only 2 or 5 are allowed (e.g., 02... or 05...)",
        }
      }
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
