/**
 * Structured Data Generators for SEO
 * Generates JSON-LD schema for various content types
 */

export const generateOrganizationSchema = () => ({
  "@context": "https://schema.org",
  "@type": "Organization",
  name: "DATAGOD",
  url: "https://www.datagod.store",
  logo: "https://www.datagod.store/favicon-v2.jpeg",
  description: "Affordable data packages, airtime, and mobile services for multiple networks in Ghana",
  sameAs: [
    "https://web.facebook.com/datagod.store",
    "https://twitter.com/datagodstore",
    "https://www.instagram.com/datagodstore",
  ],
  contactPoint: {
    "@type": "ContactPoint",
    contactType: "Customer Service",
    telephone: "+233-XXX-XXX-XXXX",
    availableLanguage: ["en"],
  },
});

export const generateHomepageSchema = () => ({
  "@context": "https://schema.org",
  "@type": "WebSite",
  name: "DATAGOD",
  url: "https://www.datagod.store",
  description: "Buy affordable data packages from multiple networks with instant delivery",
  potentialAction: {
    "@type": "SearchAction",
    target: {
      "@type": "EntryPoint",
      urlTemplate: "https://www.datagod.store/shop?search={search_term_string}",
    },
    query_input: "required name=search_term_string",
  },
});

export const generateProductSchema = (
  name: string,
  price: number,
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
    url: `https://www.datagod.store/shop/${name.toLowerCase().replace(/\s+/g, "-")}`,
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

export const generateLocalBusinessSchema = () => ({
  "@context": "https://schema.org",
  "@type": "LocalBusiness",
  name: "DATAGOD",
  url: "https://www.datagod.store",
  logo: "https://www.datagod.store/favicon-v2.jpeg",
  areaServed: "GH",
  description: "Online data package and mobile services retailer",
  serviceType: "Data Packages, Airtime, Mobile Services",
});
