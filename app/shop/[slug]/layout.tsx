'use client'

import { OrderProvider } from '@/contexts/OrderContext'

export default function ShopLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <OrderProvider>
      {children}
    </OrderProvider>
  )
}
