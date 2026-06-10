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

export function isValidDob(dob: string): boolean {
  return /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(dob.trim().replace(/-/g, "/"))
}

export function isValidExamYear(year: number): boolean {
  return Number.isInteger(year) && year >= 2015 && year <= new Date().getFullYear()
}

export function isValidGhanaPhone(phone: string): boolean {
  return /^0[2345]\d{8}$/.test(phone.trim())
}
