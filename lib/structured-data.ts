/**
 * Structured Data Generators for SEO
 * Generates JSON-LD schema for various content types
 */

// The site-wide Organization + WebSite JSON-LD lives in lib/seo/json-ld.ts
// (buildSiteJsonLd), rendered by app/layout.tsx on the main host only.
// LocalBusiness was removed (no address or phone): re-add it only with a real
// address and phone that match the Google Business Profile.

export const generateProductSchema = (
  name: string,
  price: number,
  url: string,
  currency: string = "GHS",
  description?: string,
  rating?: number,
  reviewCount?: number
) => ({
  "@context": "https://schema.org",
  "@type": "Product",
  name,
  description: description || `${name} - Data package for Ghana`,
  offers: {
    "@type": "Offer",
    price: price.toString(),
    priceCurrency: currency,
    availability: "https://schema.org/InStock",
    url,
  },
  ...(rating && reviewCount && {
    aggregateRating: {
      "@type": "AggregateRating",
      ratingValue: rating.toString(),
      reviewCount: reviewCount.toString(),
    },
  }),
});

export const generateBreadcrumbSchema = (
  items: Array<{
    name: string;
    url: string;
  }>
) => ({
  "@context": "https://schema.org",
  "@type": "BreadcrumbList",
  itemListElement: items.map((item, index) => ({
    "@type": "ListItem",
    position: (index + 1).toString(),
    name: item.name,
    item: item.url,
  })),
});

export const generateFAQSchema = (
  faqs: Array<{
    question: string;
    answer: string;
  }>
) => ({
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: faqs.map((faq) => ({
    "@type": "Question",
    name: faq.question,
    acceptedAnswer: {
      "@type": "Answer",
      text: faq.answer,
    },
  })),
});
