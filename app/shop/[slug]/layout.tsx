import { cookies } from 'next/headers'
import { createClient } from '@supabase/supabase-js'
import { generateShopCookie } from '@/lib/shop-token'
import ShopClientWrapper from './shop-client-wrapper'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export default async function ShopLayout({
  children,
  params,
}: {
  children: React.ReactNode
  params: Promise<{ slug: string }>
}) {
  const { slug } = await params

  try {
    const { data: shop } = await supabase
      .from('user_shops')
      .select('id')
      .eq('shop_slug', slug)
      .single()

    if (shop?.id) {
      const token = generateShopCookie(shop.id)
      const cookieStore = await cookies()
      cookieStore.set('__shop_sess', token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 30 * 60,
        path: '/',
      })
    }
  } catch {
    // Non-fatal — orders/create will log missing cookie and enforce once rolled out
  }

  return <ShopClientWrapper>{children}</ShopClientWrapper>
}
