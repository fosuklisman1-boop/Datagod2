import { guidePageMetadata, guideStaticParams, renderGuidePage } from "@/components/seo/guide-page"

export function generateStaticParams() {
  return guideStaticParams()
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  return guidePageMetadata((await params).slug)
}

export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  return renderGuidePage((await params).slug)
}
