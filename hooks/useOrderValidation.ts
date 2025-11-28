import { useCallback } from 'react'
import { CustomerData } from '@/contexts/OrderContext'

export interface ValidationError {
  field: keyof CustomerData
  message: string
}

export interface ValidationResult {
  isValid: boolean
  errors: ValidationError[]
  errorMap: Partial<Record<keyof CustomerData, string>>
}

const validateEmail = (email: string): string | null => {
  if (!email.trim()) return 'Email is required'
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return 'Invalid email format'
  return null
}

const validateName = (name: string): string | null => {
  if (!name.trim()) return 'Name is required'
  if (name.trim().length < 2) return 'Name must be at least 2 characters'
  return null
}

const validatePhone = (phone: string): string | null => {
  if (!phone.trim()) return 'Phone number is required'

  const cleaned = phone.replace(/\D/g, '')
  const normalized = cleaned.length === 9 ? '0' + cleaned : cleaned

  if (normalized.length !== 10) return 'Phone must be 10 digits'
  if (!normalized.startsWith('0')) return 'Phone must start with 0'
  if (!['2', '5'].includes(normalized[2])) {
    return 'Phone must start with 02 or 05 (MTN, Telecel, AT)'
  }

  return null
}

export const useOrderValidation = () => {
  const validateField = useCallback(
    (field: keyof CustomerData, value: string): string | null => {
      switch (field) {
        case 'email':
          return validateEmail(value)
        case 'name':
          return validateName(value)
        case 'phone':
          return validatePhone(value)
        default:
          return null
      }
    },
    []
  )

  const validateAll = useCallback((data: CustomerData): ValidationResult => {
    const errors: ValidationError[] = []
    const errorMap: Partial<Record<keyof CustomerData, string>> = {}

    // Validate each field
    const nameError = validateName(data.name)
    if (nameError) {
      errors.push({ field: 'name', message: nameError })
      errorMap.name = nameError
    }

    const emailError = validateEmail(data.email)
    if (emailError) {
      errors.push({ field: 'email', message: emailError })
      errorMap.email = emailError
    }

    const phoneError = validatePhone(data.phone)
    if (phoneError) {
      errors.push({ field: 'phone', message: phoneError })
      errorMap.phone = phoneError
    }

    return {
      isValid: errors.length === 0,
      errors,
      errorMap,
    }
  }, [])

  return {
    validateField,
    validateAll,
    validateEmail,
    validateName,
    validatePhone,
  }
}
