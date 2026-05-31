'use client'

import { OrderProvider } from '@/contexts/OrderContext'

export default function ShopClientWrapper({ children }: { children: React.ReactNode }) {
  return <OrderProvider>{children}</OrderProvider>
}
