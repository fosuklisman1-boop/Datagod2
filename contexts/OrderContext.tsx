'use client'

import React, { createContext, useContext, useReducer, useCallback, ReactNode } from 'react'
import { toast } from 'sonner'

// Types
export type OrderPlacementState =
  | 'BROWSING'
  | 'PACKAGE_SELECTED'
  | 'CHECKOUT_OPEN'
  | 'FORM_VALIDATING'
  | 'ORDER_CREATING'
  | 'ORDER_CREATED'
  | 'REDIRECTING'
  | 'ERROR_FORM_VALIDATION'
  | 'ERROR_ORDER_CREATION'
  | 'ERROR_NETWORK'

export interface CustomerData {
  name: string
  email: string
  phone: string
}

export interface SelectedPackageData {
  id: string
  network: string
  size: string | number
  description: string
  price: number
  profit_margin: number
  shop_package_id: string
  package_id: string
}

export interface OrderData {
  id: string
  shop_id: string
  customer_email: string
  customer_phone: string
  customer_name: string
  total_price: number
  payment_status: string
  created_at: string
}

export interface ErrorData {
  code: string
  message: string
  details?: string
  recoveryOptions: Array<'RETRY' | 'EDIT_FORM' | 'START_OVER' | 'CONTACT_SUPPORT'>
}

export interface OrderContextType {
  // State
  selectedNetwork: string | null
  selectedPackage: SelectedPackageData | null
  customerData: CustomerData
  order: OrderData | null
  shop: any

  // Status
  state: OrderPlacementState
  error: ErrorData | null
  isProcessing: boolean
  progress: number // 0-100

  // Actions
  selectNetwork: (network: string) => void
  selectPackage: (pkg: SelectedPackageData) => void
  updateCustomer: (data: Partial<CustomerData>) => void
  submitOrder: (shopData: any) => Promise<void>
  retryOrder: () => Promise<void>
  editForm: () => void
  resetFlow: () => void
  setShop: (shop: any) => void
}

interface OrderState {
  selectedNetwork: string | null
  selectedPackage: SelectedPackageData | null
  customerData: CustomerData
  order: OrderData | null
  shop: any
  state: OrderPlacementState
  error: ErrorData | null
  isProcessing: boolean
  progress: number
}

type OrderAction =
  | { type: 'SET_NETWORK'; payload: string }
  | { type: 'SET_PACKAGE'; payload: SelectedPackageData }
  | { type: 'UPDATE_CUSTOMER'; payload: Partial<CustomerData> }
  | { type: 'SET_STATE'; payload: OrderPlacementState }
  | { type: 'SET_ERROR'; payload: ErrorData | null }
  | { type: 'SET_ORDER'; payload: OrderData }
  | { type: 'SET_PROCESSING'; payload: boolean }
  | { type: 'SET_PROGRESS'; payload: number }
  | { type: 'SET_SHOP'; payload: any }
  | { type: 'RESET_FLOW' }
  | { type: 'RESTORE_DRAFT'; payload: Partial<OrderState> }

const initialState: OrderState = {
  selectedNetwork: null,
  selectedPackage: null,
  customerData: { name: '', email: '', phone: '' },
  order: null,
  shop: null,
  state: 'BROWSING',
  error: null,
  isProcessing: false,
  progress: 0,
}

const OrderContext = createContext<OrderContextType | undefined>(undefined)

// Reducer
const orderReducer = (state: OrderState, action: OrderAction): OrderState => {
  switch (action.type) {
    case 'SET_NETWORK':
      return { ...state, selectedNetwork: action.payload, progress: 25 }

    case 'SET_PACKAGE':
      return { ...state, selectedPackage: action.payload, state: 'PACKAGE_SELECTED', progress: 50 }

    case 'UPDATE_CUSTOMER':
      return {
        ...state,
        customerData: { ...state.customerData, ...action.payload },
      }

    case 'SET_STATE':
      return { ...state, state: action.payload }

    case 'SET_ERROR':
      return { ...state, error: action.payload }

    case 'SET_ORDER':
      return { ...state, order: action.payload, state: 'ORDER_CREATED', progress: 100 }

    case 'SET_PROCESSING':
      return { ...state, isProcessing: action.payload }

    case 'SET_PROGRESS':
      return { ...state, progress: action.payload }

    case 'SET_SHOP':
      return { ...state, shop: action.payload }

    case 'RESET_FLOW':
      return initialState

    case 'RESTORE_DRAFT':
      return { ...state, ...action.payload }

    default:
      return state
  }
}

// Provider Component
export const OrderProvider = ({ children }: { children: ReactNode }) => {
  const [state, dispatch] = useReducer(orderReducer, initialState)

  // Action handlers
  const selectNetwork = useCallback((network: string) => {
    dispatch({ type: 'SET_NETWORK', payload: network })
  }, [])

  const selectPackage = useCallback((pkg: SelectedPackageData) => {
    dispatch({ type: 'SET_PACKAGE', payload: pkg })
    dispatch({ type: 'SET_STATE', payload: 'CHECKOUT_OPEN' })
    dispatch({ type: 'SET_PROGRESS', payload: 50 })

    // Save to localStorage
    saveDraftToLocalStorage({
      selectedNetwork: state.selectedNetwork,
      selectedPackage: pkg,
      timestamp: Date.now(),
    })
  }, [state.selectedNetwork])

  const updateCustomer = useCallback((data: Partial<CustomerData>) => {
    dispatch({ type: 'UPDATE_CUSTOMER', payload: data })
  }, [])

  const setShop = useCallback((shop: any) => {
    dispatch({ type: 'SET_SHOP', payload: shop })
  }, [])

  const submitOrder = useCallback(
    async (shopData: any) => {
      dispatch({ type: 'SET_STATE', payload: 'FORM_VALIDATING' })
      dispatch({ type: 'SET_PROCESSING', payload: true })
      dispatch({ type: 'SET_ERROR', payload: null })

      try {
        // Validate form
        const validation = validateCustomerData(state.customerData)
        if (!validation.isValid) {
          throw {
            code: 'VALIDATION_ERROR',
            message: 'Please fill in all required fields correctly',
            details: validation.errors.join(', '),
            recoveryOptions: ['EDIT_FORM'],
          }
        }

        dispatch({ type: 'SET_STATE', payload: 'ORDER_CREATING' })
        dispatch({ type: 'SET_PROGRESS', payload: 75 })

        // Import shop service
        const { shopOrderService } = await import('@/lib/shop-service')

        if (!state.selectedPackage || !shopData) {
          throw {
            code: 'MISSING_DATA',
            message: 'Package or shop data is missing',
            recoveryOptions: ['START_OVER'],
          }
        }

        const pkg = state.selectedPackage
        const normalizedPhone = normalizePhoneNumber(state.customerData.phone)
        const totalPrice = pkg.price + pkg.profit_margin

        // NOTE: Customer tracking is now done AFTER payment is confirmed
        // This prevents inflated customer revenue from abandoned orders
        // See: Paystack webhook and wallet/debit route for customer tracking

        const order = await shopOrderService.createShopOrder({
          shop_id: shopData.id,
          customer_name: state.customerData.name,
          customer_email: state.customerData.email,
          customer_phone: normalizedPhone,
          shop_package_id: pkg.shop_package_id,
          package_id: pkg.package_id,
          network: pkg.network,
          volume_gb: parseInt(pkg.size.toString().replace(/[^0-9]/g, '')) || 0,
          base_price: pkg.price,
          profit_amount: pkg.profit_margin,
          total_price: totalPrice,
        })

        dispatch({ type: 'SET_ORDER', payload: order })
        dispatch({ type: 'SET_PROGRESS', payload: 100 })

        // Clear draft
        clearDraftFromLocalStorage()

        // Show success message
        toast.success('Order created! Redirecting to confirmation...')

        // Return order for navigation
        return order
      } catch (error: any) {
        const errorData: ErrorData = {
          code: error.code || 'UNKNOWN_ERROR',
          message: error.message || 'Failed to create order',
          details: error.details,
          recoveryOptions: error.recoveryOptions || ['RETRY', 'START_OVER'],
        }

        dispatch({ type: 'SET_ERROR', payload: errorData })

        if (error.code === 'VALIDATION_ERROR') {
          dispatch({ type: 'SET_STATE', payload: 'ERROR_FORM_VALIDATION' })
        } else {
          dispatch({ type: 'SET_STATE', payload: 'ERROR_ORDER_CREATION' })
        }

        dispatch({ type: 'SET_PROCESSING', payload: false })
        toast.error(errorData.message)

        throw error
      }
    },
    [state.customerData, state.selectedPackage]
  )

  const retryOrder = useCallback(async () => {
    if (!state.shop) return
    await submitOrder(state.shop)
  }, [submitOrder, state.shop])

  const editForm = useCallback(() => {
    dispatch({ type: 'SET_STATE', payload: 'CHECKOUT_OPEN' })
    dispatch({ type: 'SET_ERROR', payload: null })
  }, [])

  const resetFlow = useCallback(() => {
    dispatch({ type: 'RESET_FLOW' })
    clearDraftFromLocalStorage()
  }, [])

  const value: OrderContextType = {
    selectedNetwork: state.selectedNetwork,
    selectedPackage: state.selectedPackage,
    customerData: state.customerData,
    order: state.order,
    shop: state.shop,
    state: state.state,
    error: state.error,
    isProcessing: state.isProcessing,
    progress: state.progress,
    selectNetwork,
    selectPackage,
    updateCustomer,
    submitOrder,
    retryOrder,
    editForm,
    resetFlow,
    setShop,
  }

  return <OrderContext.Provider value={value}>{children}</OrderContext.Provider>
}

// Hook
export const useOrderContext = (): OrderContextType => {
  const context = useContext(OrderContext)
  if (context === undefined) {
    throw new Error('useOrderContext must be used within OrderProvider')
  }
  return context
}

// Helper functions
function normalizePhoneNumber(phone: string): string {
  const cleaned = phone.replace(/\D/g, '')
  return cleaned.length === 9 ? '0' + cleaned : cleaned
}

function validateCustomerData(data: CustomerData): { isValid: boolean; errors: string[] } {
  const errors: string[] = []

  if (!data.name.trim() || data.name.trim().length < 2) {
    errors.push('Name must be at least 2 characters')
  }

  if (!data.email.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) {
    errors.push('Invalid email format')
  }

  const cleaned = data.phone.replace(/\D/g, '')
  const normalized = cleaned.length === 9 ? '0' + cleaned : cleaned

  if (normalized.length !== 10 || !normalized.startsWith('0') || !['2', '5'].includes(normalized[2])) {
    errors.push('Invalid phone number')
  }

  return { isValid: errors.length === 0, errors }
}

// LocalStorage helpers
const DRAFT_KEY = 'order_draft'

function saveDraftToLocalStorage(draft: any) {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(draft))
  } catch (error) {
    console.error('Failed to save draft:', error)
  }
}

export function getDraftFromLocalStorage() {
  try {
    const draft = localStorage.getItem(DRAFT_KEY)
    if (!draft) return null

    const data = JSON.parse(draft)
    // Only restore if draft is less than 24 hours old
    if (Date.now() - data.timestamp > 24 * 60 * 60 * 1000) {
      clearDraftFromLocalStorage()
      return null
    }

    return data
  } catch (error) {
    console.error('Failed to get draft:', error)
    return null
  }
}

function clearDraftFromLocalStorage() {
  try {
    localStorage.removeItem(DRAFT_KEY)
  } catch (error) {
    console.error('Failed to clear draft:', error)
  }
}

export function restoreDraftInContext(dispatch: any, draft: any) {
  if (draft) {
    dispatch({ type: 'RESTORE_DRAFT', payload: draft })
  }
}
