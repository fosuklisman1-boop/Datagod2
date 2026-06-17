// Pure validation helpers for the Results Check Service storefront form.
// No Supabase import — must be safe to import from a "use client" component.

export const EXAM_BOARDS = ["WASSCE", "BECE", "NOVDEC"] as const
export type ExamBoard = typeof EXAM_BOARDS[number]

export function isValidIndexNumber(examBoard: ExamBoard, index: string): boolean {
  return examBoard === "BECE" ? /^\d{10}$|^\d{12}$/.test(index) : /^\d{10}$/.test(index)
}

// Board-aware: WAEC Ghana cards differ by board. WASSCE/NOVDEC = 12-digit NUMERIC
// PIN + letter-prefixed serial (e.g. WGR1900112581). BECE = ALPHANUMERIC PIN
// (e.g. 5FBR336742D4) + NUMERIC serial (e.g. 252100270719) — the reverse layout.
export function isValidVoucherPin(examBoard: ExamBoard, pin: string): boolean {
  const p = pin.trim()
  return examBoard === "BECE" ? /^[A-Za-z0-9]{10,12}$/.test(p) : /^\d{12}$/.test(p)
}

export function isValidVoucherSerial(examBoard: ExamBoard, serial: string): boolean {
  const s = serial.trim()
  return examBoard === "BECE" ? /^\d{8,14}$/.test(s) : /^[A-Z]{1,4}\d{7,15}$/.test(s.toUpperCase())
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
