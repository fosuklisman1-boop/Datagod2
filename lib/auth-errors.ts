/**
 * Converts Supabase auth errors to user-friendly messages
 */
export const getAuthErrorMessage = (error: any): { message: string; type: 'user-exists' | 'invalid-credentials' | 'network' | 'generic' } => {
  const errorMessage = error?.message?.toLowerCase() || ''
  const errorCode = error?.code?.toLowerCase() || ''

  // User already exists errors
  if (
    errorMessage.includes('user already registered') ||
    errorMessage.includes('duplicate key') ||
    errorMessage.includes('already exists') ||
    errorCode.includes('user_exists')
  ) {
    return {
      message: 'This email is already registered. Please sign in instead or use a different email.',
      type: 'user-exists',
    }
  }

  // Invalid credentials (wrong password)
  if (
    errorMessage.includes('invalid login credentials') ||
    errorMessage.includes('invalid email or password') ||
    errorCode.includes('invalid_credentials')
  ) {
    return {
      message: 'Invalid email or password. Please check and try again.',
      type: 'invalid-credentials',
    }
  }

  // Invalid email format
  if (
    errorMessage.includes('invalid email') ||
    errorMessage.includes('email format')
  ) {
    return {
      message: 'Please enter a valid email address.',
      type: 'generic',
    }
  }

  // Weak password
  if (
    errorMessage.includes('password') &&
    (errorMessage.includes('weak') || errorMessage.includes('too short'))
  ) {
    return {
      message: 'Password must be at least 6 characters long.',
      type: 'generic',
    }
  }

  // Network errors
  if (
    errorMessage.includes('network') ||
    errorMessage.includes('fetch') ||
    errorMessage.includes('timeout')
  ) {
    return {
      message: 'Network error. Please check your internet connection and try again.',
      type: 'network',
    }
  }

  // User not found
  if (
    errorMessage.includes('user not found') ||
    errorCode.includes('user_not_found')
  ) {
    return {
      message: 'No account found with this email. Please check or create a new account.',
      type: 'generic',
    }
  }

  // Account not confirmed
  if (
    errorMessage.includes('email not confirmed') ||
    errorMessage.includes('email_not_confirmed')
  ) {
    return {
      message: 'Please verify your email before signing in. Check your inbox for the verification link.',
      type: 'generic',
    }
  }

  // Default generic error
  return {
    message: error?.message || 'An error occurred. Please try again.',
    type: 'generic',
  }
}
