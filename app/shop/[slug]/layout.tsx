import ShopClientWrapper from './shop-client-wrapper'

export default async function ShopLayout({
  children,
}: {
  children: React.ReactNode
  params: Promise<{ slug: string }>
}) {
  return <ShopClientWrapper>{children}</ShopClientWrapper>
}
