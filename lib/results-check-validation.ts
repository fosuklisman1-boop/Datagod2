// Pure validation helpers for the Results Check Service storefront form.
// No Supabase import — must be safe to import from a "use client" component.

export const EXAM_BOARDS = ["WASSCE", "BECE", "NOVDEC"] as const
export type ExamBoard = typeof EXAM_BOARDS[number]

export function isValidIndexNumber(examBoard: ExamBoard, index: string): boolean {
  return examBoard === "BECE" ? /^\d{10}$|^\d{12}$/.test(index) : /^\d{10}$/.test(index)
}

export function isValidVoucherPin(pin: string): boolean {
  return /^\d{12}$/.test(pin)
}

export function isValidVoucherSerial(serial: string): boolean {
  return /^[A-Z]{1,4}\d{7,15}$/.test(serial.toUpperCase())
}

// Validates a real calendar date in DD/MM/YYYY form (not just the shape):
// rejects impossible dates like 31/02, future dates, and implausible years.
export function isValidDob(dob: string): boolean {
  const m = dob.trim().replace(/-/g, "/").match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (!m) return false
  const day = parseInt(m[1], 10)
  const month = parseInt(m[2], 10)
  const year = parseInt(m[3], 10)
  const currentYear = new Date().getFullYear()
  if (month < 1 || month > 12) return false
  if (year < 1940 || year > currentYear) return false
  // Days valid for that month/year (handles leap years via day-0 of next month).
  const daysInMonth = new Date(year, month, 0).getDate()
  if (day < 1 || day > daysInMonth) return false
  // Must be a date in the past.
  return new Date(year, month - 1, day).getTime() < Date.now()
}

export function isValidExamYear(year: number): boolean {
  return Number.isInteger(year) && year >= 1980 && year <= new Date().getFullYear()
}

export function isValidGhanaPhone(phone: string): boolean {
  return /^0[2345]\d{8}$/.test(phone.trim())
}
