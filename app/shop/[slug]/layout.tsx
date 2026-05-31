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
    const { data: shop, error: shopErr } = await supabase
      .from('user_shops')
      .select('id')
      .eq('shop_slug', slug)
      .single()

    if (shopErr) {
      console.warn(`[SHOP-LAYOUT] slug=${slug} supabase_error=${shopErr.message}`)
    }

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
      console.log(`[SHOP-LAYOUT] ✓ Cookie set slug=${slug} shop_id=${shop.id} secret_configured=${!!process.env.SHOP_TOKEN_SECRET}`)
    } else {
      console.warn(`[SHOP-LAYOUT] ⚠️ No shop found for slug=${slug}`)
    }
  } catch (e) {
    console.error(`[SHOP-LAYOUT] ❌ Exception for slug=${slug}:`, e instanceof Error ? e.message : e)
  }

  return <ShopClientWrapper>{children}</ShopClientWrapper>
}
